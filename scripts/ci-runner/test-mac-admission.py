#!/usr/bin/env python3
"""Table test of which runs may use the fleet's self-hosted Mac (beadbox-449.4).

Every row is one named case, admitted or refused, for one Mac job. The test
reads the LITERAL guard text from .github/workflows/ (each job's `if:`, the
install-script matrix exclude, and mac-admission's `run:` block) and evaluates
it the way GitHub does, so it cannot drift from what actually runs:

  - `if:` and `${{ }}` expressions go through a small evaluator for the subset
    these guards use: == != && || ! ( ), string literals, true/false/null,
    context paths, startsWith(), always(), cancelled(). As in GitHub, == and
    startsWith compare strings case-insensitively, && and || return one of
    their operands, and an unknown context path is null.
  - mac-admission's run block runs under bash against a synthetic git origin:
    main, release/v0.31.0 (main plus a version bump: parent on main) and
    release/v9.9.9 (a bump on a commit that is not on main).

Reds run every time and must fail exactly where expected:
  - a stand-in that never refuses (every guard true, run block `echo admitted`)
    must fail every refused row and no admitted row;
  - mutations of the real text: mac-admission without its parent-on-main check,
    packaged-smoke without its release.yml-only release-branch clause, and
    release.yml's packaged-smoke call without mac-admission.

ACCIDENT PREVENTION ONLY: a fork's pull request runs its own copy of these
files; forks are stopped by the external-contributor approval rule.

Usage: python3 -I scripts/ci-runner/test-mac-admission.py  (from the repo root)
"""

import os
import re
import subprocess
import sys
import tempfile

ROOT = os.getcwd()
WF = os.path.join(ROOT, ".github", "workflows")

# ── Reading the literal guard text ──────────────────────────────────────────


def read(name):
    with open(os.path.join(WF, name), encoding="utf-8") as f:
        return f.read()


def job_block(text, job):
    """The lines of one job: from '  <job>:' to the next job at indent 2."""
    lines = text.split("\n")
    start = None
    jobs_at = lines.index("jobs:")  # only job ids, never a trigger of the same name
    for i, line in enumerate(lines):
        if i > jobs_at and (line == f"  {job}:" or line.startswith(f"  {job}: ")):
            start = i
            break
    if start is None:
        raise SystemExit(f"FAIL: job '{job}' not found")
    out = [lines[start]]
    for line in lines[start + 1 :]:
        if re.match(r"^  [A-Za-z0-9_-]+:\s*$", line) or re.match(r"^\S", line):
            break
        out.append(line)
    return out


def scalar_after(lines, key_re, indent):
    """The value of a key at `indent`: inline, or a folded/literal block below it."""
    for i, line in enumerate(lines):
        m = re.match(r"^" + " " * indent + key_re + r":\s*(.*)$", line)
        if not m:
            continue
        rest = m.group(1).strip()
        if rest not in (">-", ">", "|", "|-"):
            return rest
        body = []
        for nxt in lines[i + 1 :]:
            if nxt.strip() and len(nxt) - len(nxt.lstrip(" ")) <= indent:
                break
            body.append(nxt)
        sep = "\n" if rest.startswith("|") else " "
        return sep.join(s.strip() if sep == " " else s for s in body).strip("\n ")
    raise SystemExit(f"FAIL: key {key_re} not found at indent {indent}")


def job_if(text, job):
    return scalar_after(job_block(text, job), "if", 4)


def step_run(text, job, step_name):
    block = job_block(text, job)
    for i, line in enumerate(block):
        if line.strip() == f"- name: {step_name}":
            step = []
            ind = len(line) - len(line.lstrip(" "))
            for nxt in block[i + 1 :]:
                if nxt.strip().startswith("- ") and len(nxt) - len(nxt.lstrip(" ")) == ind:
                    break
                step.append(nxt)
            run = scalar_after(step, "run", ind + 2)
            # Dedent the literal block.
            body = run.split("\n")
            pad = min(len(s) - len(s.lstrip(" ")) for s in body if s.strip())
            return "\n".join(s[pad:] for s in body)
    raise SystemExit(f"FAIL: step '{step_name}' not found in {job}")


def matrix_exclude(text, job):
    for line in job_block(text, job):
        m = re.match(r"^\s*- os:\s*(\$\{\{.*\}\})\s*$", line)
        if m:
            return m.group(1)
    raise SystemExit(f"FAIL: no expression matrix exclude in {job}")


# ── A GitHub expression evaluator (the subset these guards use) ─────────────

TOKEN = re.compile(
    r"\s*(?:(?P<str>'(?:[^']|'')*')|(?P<op>==|!=|&&|\|\||[!(),])"
    r"|(?P<id>[A-Za-z_][A-Za-z0-9_.\-]*))"
)


def tokenize(s):
    pos, out = 0, []
    s = s.strip()
    while pos < len(s):
        m = TOKEN.match(s, pos)
        if not m or m.end() == pos:
            raise ValueError(f"cannot read expression at: {s[pos:pos + 30]!r}")
        pos = m.end()
        if m.group("str") is not None:
            out.append(("str", m.group("str")[1:-1].replace("''", "'")))
        elif m.group("op"):
            out.append(("op", m.group("op")))
        else:
            out.append(("id", m.group("id")))
    return out


def truthy(v):
    return v not in (None, False, "", 0)


def eq(a, b):
    if isinstance(a, str) and isinstance(b, str):
        return a.lower() == b.lower()
    if type(a) is not type(b):
        return False  # GitHub coerces mixed types to numbers; none of ours match
    return a == b


class Expr:
    def __init__(self, src, ctx):
        src = src.strip()
        if src.startswith("${{") and src.endswith("}}"):
            src = src[3:-2]
        self.t = tokenize(src)
        self.i = 0
        self.ctx = ctx

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self, kind=None, val=None):
        tok = self.peek()
        if tok[0] is None or (kind and tok[0] != kind) or (val and tok[1] != val):
            raise ValueError(f"expected {val or kind}, got {tok}")
        self.i += 1
        return tok

    def run(self):
        v = self.or_()
        if self.i != len(self.t):
            raise ValueError(f"trailing tokens: {self.t[self.i:]}")
        return v

    def or_(self):
        v = self.and_()
        while self.peek() == ("op", "||"):
            self.take()
            r = self.and_()
            v = v if truthy(v) else r
        return v

    def and_(self):
        v = self.cmp()
        while self.peek() == ("op", "&&"):
            self.take()
            r = self.cmp()
            v = r if truthy(v) else v
        return v

    def cmp(self):
        v = self.unary()
        while self.peek() in (("op", "=="), ("op", "!=")):
            op = self.take()[1]
            r = self.unary()
            v = eq(v, r) if op == "==" else not eq(v, r)
        return v

    def unary(self):
        if self.peek() == ("op", "!"):
            self.take()
            return not truthy(self.unary())
        return self.atom()

    def atom(self):
        kind, val = self.peek()
        if kind == "str":
            self.take()
            return val
        if (kind, val) == ("op", "("):
            self.take()
            v = self.or_()
            self.take("op", ")")
            return v
        if kind == "id":
            self.take()
            if self.peek() == ("op", "("):
                self.take()
                args = []
                if self.peek() != ("op", ")"):
                    args.append(self.or_())
                    while self.peek() == ("op", ","):
                        self.take()
                        args.append(self.or_())
                self.take("op", ")")
                return self.call(val, args)
            if val in ("true", "false", "null"):
                return {"true": True, "false": False, "null": None}[val]
            v = self.ctx
            for part in val.split("."):
                v = v.get(part) if isinstance(v, dict) else None
            return v
        raise ValueError(f"unexpected token {kind} {val}")

    def call(self, name, args):
        if name == "always":
            return True
        if name == "cancelled":
            return False
        if name == "startsWith":
            a, b = (x if isinstance(x, str) else "" for x in args)
            return a.lower().startswith(b.lower())
        raise ValueError(f"function {name}() is not modelled")


def evaluate(src, ctx):
    return Expr(src, ctx).run()


# ── The synthetic origin for mac-admission's parent-on-main check ───────────

GIT_ENV = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
    "HOME": "",
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
}


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], cwd=cwd, env=GIT_ENV, check=True, capture_output=True, text=True
    ).stdout.strip()


def make_origin(tmp):
    work = os.path.join(tmp, "seed")
    origin = os.path.join(tmp, "origin.git")
    os.makedirs(work)
    git(work, "init", "-q", "-b", "main")
    git(work, "commit", "-q", "--allow-empty", "-m", "A")
    git(work, "commit", "-q", "--allow-empty", "-m", "B")
    git(work, "checkout", "-q", "-b", "release/v0.31.0")
    git(work, "commit", "-q", "--allow-empty", "-m", "bump v0.31.0")
    git(work, "checkout", "-q", "-b", "release/v9.9.9", "main~1")
    git(work, "commit", "-q", "--allow-empty", "-m", "X, never on main")
    git(work, "commit", "-q", "--allow-empty", "-m", "bump v9.9.9")
    heads = {
        b: git(work, "rev-parse", b) for b in ("main", "release/v0.31.0", "release/v9.9.9")
    }
    git(tmp, "clone", "-q", "--bare", work, origin)
    return origin, heads


def run_block(script, env, origin, ref_branch, tmp):
    clone = tempfile.mkdtemp(prefix="clone-", dir=tmp)
    git(tmp, "clone", "-q", origin, clone)
    if ref_branch:
        git(clone, "checkout", "-q", ref_branch)
    full = dict(GIT_ENV, **env)
    p = subprocess.run(
        ["bash", "-e", "-c", script], cwd=clone, env=full, capture_output=True, text=True
    )
    said = [l for l in (p.stdout + p.stderr).splitlines() if "admitted:" in l or "refused" in l]
    return p.returncode, said[-1:] or [f"exit {p.returncode}, no admitted/refused line"]


# ── The table ───────────────────────────────────────────────────────────────

MAIN = "refs/heads/main"
REL_ON = "refs/heads/release/v0.31.0"   # parent on main
REL_OFF = "refs/heads/release/v9.9.9"   # parent not on main
RELEASE_DISPATCH = {"build_macos_arm64": True}
BUILD = {"mode": "build", "ref": "sha"}

# (row name, event, ref, release.yml inputs, expected for the release.yml Mac jobs)
RELEASE_ROWS = [
    ("scheduled Build of main", "schedule", MAIN, BUILD, True),
    ("dispatched Build of main", "workflow_dispatch", MAIN, BUILD, True),
    ("release tag push v0.31.0", "push", "refs/tags/v0.31.0", {}, True),
    ("release tag push v0.31.0-rc.1", "push", "refs/tags/v0.31.0-rc.1", {}, True),
    ("release.yml from release/v0.31.0, parent on main", "workflow_dispatch", REL_ON, RELEASE_DISPATCH, True),
    ("release.yml from release/v9.9.9, parent NOT on main", "workflow_dispatch", REL_OFF, RELEASE_DISPATCH, False),
    ("release.yml dispatched from main (not a Build)", "workflow_dispatch", MAIN, RELEASE_DISPATCH, False),
    ("another workflow from a release branch: a Build of release/v0.31.0", "workflow_dispatch", REL_ON, BUILD, False),
    ("a Build dispatched from a feature branch", "workflow_dispatch", "refs/heads/feature/x", BUILD, False),
    ("a non-release tag push (vnext)", "push", "refs/tags/vnext", {}, False),
    ("a tag push that is not a version (v1.2)", "push", "refs/tags/v1.2", {}, False),
    ("a tag push with a suffix after the version (v0.31.0-x)", "push", "refs/tags/v0.31.0-x", {}, False),
    ("release.yml from a branch named like a release (release/v1.2.3-x)", "workflow_dispatch", "refs/heads/release/v1.2.3-x", RELEASE_DISPATCH, False),
]

# (row name, event, ref, packaged-smoke inputs, called by release.yml?, expected)
PACKAGED_ROWS = [
    ("packaged-smoke dispatched on main", "workflow_dispatch", MAIN, {"tag": "v0.31.0"}, False, True),
    ("another workflow from a release branch: packaged-smoke dispatched on release/v0.31.0", "workflow_dispatch", REL_ON, {"tag": "v0.31.0"}, False, False),
    ("packaged-smoke dispatched on a feature branch", "workflow_dispatch", "refs/heads/feature/x", {"tag": "v0.31.0"}, False, False),
    ("packaged-smoke called by release.yml on a tag push", "push", "refs/tags/v0.31.0", {"tag": "v0.31.0", "artifact": "a"}, True, True),
    ("packaged-smoke called by release.yml from release/v0.31.0, parent on main", "workflow_dispatch", REL_ON, {"tag": "v0.31.0", "artifact": "a"}, True, True),
    ("packaged-smoke called by release.yml from release/v9.9.9, parent NOT on main", "workflow_dispatch", REL_OFF, {"tag": "v0.31.0", "artifact": "a"}, True, False),
]

# (row name, event, ref, github.event.inputs, expected) for install-smoke's Mac job
INSTALL_SMOKE_ROWS = [
    ("install-smoke after a Release (workflow_run on main)", "workflow_run", MAIN, {}, True),
    ("install-smoke dispatched on main", "workflow_dispatch", MAIN, {"smoke_macos_arm64": "true"}, True),
    ("install-smoke dispatched on main with macOS opted out", "workflow_dispatch", MAIN, {"smoke_macos_arm64": "false"}, False),
    ("another workflow from a release branch: install-smoke dispatched on release/v0.31.0", "workflow_dispatch", REL_ON, {"smoke_macos_arm64": "true"}, False),
]

# (row name, event, ref, expected) for install-script's Mac matrix entry
INSTALL_SCRIPT_ROWS = [
    ("install-script on a push to main", "push", MAIN, True),
    ("install-script on its schedule (main)", "schedule", MAIN, True),
    ("install-script dispatched on main", "workflow_dispatch", MAIN, True),
    ("install-script on a pull request", "pull_request", "refs/pull/1/merge", False),
    ("another workflow from a release branch: install-script dispatched on release/v0.31.0", "workflow_dispatch", REL_ON, False),
]


def gh(event, ref):
    return {"event_name": event, "ref": ref, "event": {}}


class Guards:
    """The guard texts under test; a mutation replaces one of them."""

    def __init__(self):
        rel = read("release.yml")
        self.admission_if = job_if(rel, "mac-admission")
        self.admission_run = step_run(rel, "mac-admission", "Admit only the runs the Mac is for")
        self.mac_jobs = {j: job_if(rel, j) for j in ("build-macos-arm64", "create-arm64-dmg")}
        self.smoke_call_if = job_if(rel, "packaged-smoke")
        self.smoke_call_with = "\n".join(job_block(rel, "packaged-smoke"))
        self.packaged_if = job_if(read("packaged-smoke.yml"), "smoke")
        self.install_smoke_if = job_if(read("install-smoke.yml"), "smoke-macos-arm64")
        self.install_script_exclude = matrix_exclude(read("install-script.yml"), "smoke")


def admission_result(g, event, ref, inputs, origin, tmp):
    """mac-admission's job result: skipped (its if: false), success or failure."""
    ctx = {"github": gh(event, ref), "inputs": inputs, "needs": {"validate-tag": {"result": "success"}}}
    if not truthy(evaluate(g.admission_if, ctx)):
        return "skipped", "if: false"
    branch = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else None
    env = {"EVENT": event, "REF": ref, "MODE": inputs.get("mode", "") or ""}
    heads = g.heads
    env["GITHUB_SHA"] = heads.get(branch, heads["main"]) if branch else heads["main"]
    if branch and branch not in heads:
        branch = None  # a ref with no commit of its own here: the run decides on text alone
    code, last = run_block(g.admission_run, env, origin, branch, tmp)
    return ("success" if code == 0 else "failure"), last[0]


def release_needs(event, inputs, admission):
    build = inputs.get("mode") == "build"
    return {
        "validate-tag": {"result": "success"},
        "build-frontend": {"result": "success"},
        "create-draft": {"result": "skipped" if build else "success"},
        "build-macos-arm64": {"result": "success"},
        "mac-admission": {"result": admission},
        "stage-packaged-smoke": {"result": "success", "outputs": {"has_mac": "true"}},
    }


def run_table(g, origin, tmp):
    results = []  # (row, expected, got, note)
    for name, event, ref, inputs, want in RELEASE_ROWS:
        adm, note = admission_result(g, event, ref, inputs, origin, tmp)
        ctx = {"github": gh(event, ref), "inputs": inputs, "needs": release_needs(event, inputs, adm)}
        for job, cond in g.mac_jobs.items():
            got = truthy(evaluate(cond, ctx))
            results.append((f"release.yml:{job} :: {name}", want, got, f"mac-admission {adm}: {note}"))
    for name, event, ref, inputs, called, want in PACKAGED_ROWS:
        note = "direct"
        allowed = True
        if called:
            rel_inputs = RELEASE_DISPATCH if event == "workflow_dispatch" else {}
            adm, note = admission_result(g, event, ref, rel_inputs, origin, tmp)
            ctx = {"github": gh(event, ref), "inputs": rel_inputs, "needs": release_needs(event, rel_inputs, adm)}
            allowed = truthy(evaluate(g.smoke_call_if, ctx))
            note = f"release.yml call {'runs' if allowed else 'skipped'} (mac-admission {adm})"
            inputs = dict(inputs, **g.call_inputs)
        got = allowed and truthy(evaluate(g.packaged_if, {"github": gh(event, ref), "inputs": inputs}))
        results.append((f"packaged-smoke.yml:smoke :: {name}", want, got, note))
    for name, event, ref, ev_inputs, want in INSTALL_SMOKE_ROWS:
        ctx = {"github": dict(gh(event, ref), event={"inputs": ev_inputs}), "inputs": ev_inputs}
        got = truthy(evaluate(g.install_smoke_if, ctx))
        results.append((f"install-smoke.yml:smoke-macos-arm64 :: {name}", want, got, ""))
    for name, event, ref, want in INSTALL_SCRIPT_ROWS:
        got = evaluate(g.install_script_exclude, {"github": gh(event, ref)}) != "beadbox-macos-release"
        results.append((f"install-script.yml:smoke (Mac entry) :: {name}", want, got, ""))
    return results


def call_inputs(with_text):
    """The `with:` values release.yml passes to packaged-smoke (literal strings only)."""
    out = {}
    for line in with_text.split("\n"):
        m = re.match(r"^      ([A-Za-z0-9_-]+):\s*([^$\s].*?)\s*$", line)
        if m and m.group(1) not in ("uses", "permissions", "contents", "needs", "if"):
            out[m.group(1)] = m.group(2).strip("'\"")
    return out


def failures(results):
    return [r for r in results if r[1] != r[2]]


def main():
    g = Guards()
    g.call_inputs = call_inputs(g.smoke_call_with)
    bad = 0
    with tempfile.TemporaryDirectory(prefix="mac-admission-") as tmp:
        origin, g.heads = make_origin(tmp)

        # 1. The table on the real text.
        results = run_table(g, origin, tmp)
        for row, want, got, note in results:
            ok = want == got
            bad += not ok
            word = "admitted" if got else "refused"
            print(f"{'ok' if ok else 'FAIL'} :: {row} :: {word}" + (f" ({note})" if note else ""))
        admitted = sum(1 for r in results if r[1])
        refused = len(results) - admitted
        print(f"admission table: {len(results) - bad} passed, {bad} failed ({admitted} admitted rows, {refused} refused rows)")

        # 2. Red: a stand-in that never refuses must fail every refused row, and only those.
        stand = Guards.__new__(Guards)
        stand.__dict__.update(g.__dict__)
        stand.admission_if = "true"
        stand.admission_run = "echo admitted"
        stand.mac_jobs = {j: "true" for j in g.mac_jobs}
        stand.smoke_call_if = "true"
        stand.packaged_if = "true"
        stand.install_smoke_if = "true"
        stand.install_script_exclude = "'none'"
        sr = run_table(stand, origin, tmp)
        sf = failures(sr)
        if sf and all(not r[1] for r in sf) and len(sf) == refused:
            print(f"red ok :: a stand-in that never refuses fails all {len(sf)} refused rows and no admitted row")
        else:
            print(f"red FAIL :: the never-refusing stand-in failed {len(sf)} rows; expected exactly the {refused} refused rows")
            bad += 1

        # 3. Reds: mutations of the real text, each caught by its own row.
        def mutate(attr, old, new, job=None):
            m = Guards.__new__(Guards)
            m.__dict__.update(g.__dict__)
            if job:
                m.mac_jobs = dict(g.mac_jobs)
                src = m.mac_jobs[job]
            else:
                src = getattr(g, attr)
            if old not in src:
                return None
            if job:
                m.mac_jobs[job] = src.replace(old, new)
            else:
                setattr(m, attr, src.replace(old, new))
            return m

        reds = [
            ("mac-admission without its parent-on-main check",
             mutate("admission_run", 'git merge-base --is-ancestor "${GITHUB_SHA}^" origin/main', "true"),
             "parent NOT on main"),
            ("packaged-smoke with release/v* dispatches admitted without release.yml (the old clause)",
             mutate("packaged_if", "&& inputs.admission == 'release.yml'", ""),
             "packaged-smoke dispatched on release/v0.31.0"),
            ("release.yml's packaged-smoke call without mac-admission",
             mutate("smoke_call_if", "&& needs.mac-admission.result == 'success'", ""),
             "packaged-smoke called by release.yml from release/v9.9.9"),
            ("mac-admission's tag rule without its end anchor",
             mutate("admission_run", r"(-rc\.[0-9]+)?$'", r"(-rc\.[0-9]+)?'"),
             "a tag push with a suffix after the version"),
        ]
        for label, m, row_part in reds:
            if m is None:
                print(f"red FAIL :: {label}: the text to mutate is not in the file (the red would prove nothing)")
                bad += 1
                continue
            mf = [r for r in failures(run_table(m, origin, tmp)) if row_part in r[0]]
            if mf and all(not r[1] for r in mf):
                print(f"red ok :: {label}: caught by {mf[0][0]}")
            else:
                print(f"red FAIL :: {label}: no row containing '{row_part}' failed")
                bad += 1

    print(f"mac admission: {'ok' if bad == 0 else f'{bad} problem(s)'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
