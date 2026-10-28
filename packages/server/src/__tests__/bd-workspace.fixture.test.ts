// Regression test for bb-kvsy: the bd-workspace fixture must not leak
// commits or scaffold files into a "host" git repo whose path it inherits
// via the GIT_DIR / GIT_WORK_TREE env vars.
//
// Failure mode being pinned: the bd CLI invocations inside createBdWorkspace
// shell out to git internally. Without GIT_* env stripping at the runBd
// boundary, bd's "bd init: initialize beads issue tracking" commit lands
// in the host repo (the agent's eng3/src worktree on local runs, an
// arbitrary CI checkout root on remote) instead of the tmpdir workspace.
// The bb-aeb2 fix already stripped GIT_* for the explicit `git init` /
// `git commit` calls; bb-kvsy extends the strip to the bd CLI calls too.
//
// Hermetic: we build a sentinel "host" repo in a separate tmpdir, point
// GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE at it, then run the fixture
// and assert the host's HEAD SHA + working-tree shape are unchanged.
// Nothing in this test depends on the agent's actual repo state, so it
// is safe to run in parallel with anything else.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { BD_WORKSPACE_TIMEOUT_MS, _cleanEnvForTesting, createBdWorkspace, type Workspace } from "./fixtures/bd-workspace"

// createBdWorkspace seeds 4 beads + reparents — multiple bd CLI calls in
// sequence run ~3-5s on a warm machine, more on cold caches. Mirror the
// 30s default the other fixture-using suites set.
setDefaultTimeout(BD_WORKSPACE_TIMEOUT_MS)

const run = promisify(execFile)

// Build a clean child-process env with GIT_* stripped (mirrors the
// fixture's own helper). Used for the SETUP git calls in this file —
// without it, the test's own `git init` of the sentinel host repo
// would inherit pollution from the surrounding shell or hook context.
function cleanEnv(extras: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extras }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key]
  }
  return env
}

let hostDir: string
let hostHeadBefore: string
let savedGitEnv: Record<string, string | undefined>
let ws: Workspace | null = null

beforeAll(async () => {
  // 1. Build a sentinel "host" git repo in its own tmpdir. One commit
  //    so it has a valid HEAD to compare against.
  hostDir = await mkdtemp(join(tmpdir(), "bb-kvsy-host-"))
  await run("git", ["init", "-q"], { cwd: hostDir, env: cleanEnv() })
  await run("git", ["config", "user.email", "host@local"], {
    cwd: hostDir,
    env: cleanEnv(),
  })
  await run("git", ["config", "user.name", "Host"], {
    cwd: hostDir,
    env: cleanEnv(),
  })
  await writeFile(join(hostDir, "marker.txt"), "host")
  await run("git", ["add", "marker.txt"], { cwd: hostDir, env: cleanEnv() })
  await run("git", ["commit", "-q", "-m", "host baseline"], {
    cwd: hostDir,
    env: cleanEnv(),
  })
  const { stdout } = await run("git", ["rev-parse", "HEAD"], {
    cwd: hostDir,
    env: cleanEnv(),
  })
  hostHeadBefore = stdout.trim()

  // 2. Save any pre-existing GIT_* vars so we can restore them in afterAll
  //    (in case the harness sets them — defensive, normally a no-op).
  savedGitEnv = {}
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
      savedGitEnv[key] = process.env[key]
    }
  }

  // 3. Inject GIT_* env vars on the parent process pointing at the host
  //    repo. This is exactly what the husky pre-push hook does (and what
  //    surfaced bb-aeb2 + bb-kvsy in the first place). The fixture under
  //    test must strip these at its runBd boundary so neither bd nor git
  //    inside the fixture writes to the host repo.
  process.env.GIT_DIR = join(hostDir, ".git")
  process.env.GIT_WORK_TREE = hostDir
  process.env.GIT_INDEX_FILE = join(hostDir, ".git", "index")
  process.env.GIT_AUTHOR_NAME = "Hook Author"
  process.env.GIT_AUTHOR_EMAIL = "hook@local"
  process.env.GIT_COMMITTER_NAME = "Hook Committer"
  process.env.GIT_COMMITTER_EMAIL = "hook@local"
})

afterAll(async () => {
  if (ws) {
    await ws.cleanup().catch(() => {})
  }
  // Remove the GIT_* vars we injected, then restore originals
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    delete process.env[key]
  }
  for (const [key, val] of Object.entries(savedGitEnv ?? {})) {
    if (val !== undefined) process.env[key] = val
  }
  if (hostDir) {
    await rm(hostDir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("bd-workspace fixture: no host-repo pollution under inherited GIT_* env (bb-kvsy)", () => {
  test("createBdWorkspace runs successfully with GIT_DIR pointed at a sentinel host", async () => {
    ws = await createBdWorkspace()
    expect(ws.root).toBeTruthy()
    expect(existsSync(ws.dbPath)).toBe(true)
    expect(ws.seedIds.epic1).toBeTruthy()
    expect(ws.seedIds.test1).toBeTruthy()
  })

  test("host repo HEAD SHA is unchanged — no 'bd init: initialize beads issue tracking' commit landed", async () => {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], {
      cwd: hostDir,
      env: cleanEnv(),
    })
    const hostHeadAfter = stdout.trim()
    expect(hostHeadAfter).toBe(hostHeadBefore)
  })

  test("host repo log has no 'bd init' commit message", async () => {
    const { stdout } = await run("git", ["log", "--oneline", "--all"], {
      cwd: hostDir,
      env: cleanEnv(),
    })
    expect(stdout).not.toContain("bd init")
    expect(stdout).not.toContain("initialize beads issue tracking")
    // Exactly one commit (the host baseline we made in beforeAll).
    const lines = stdout.trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("host baseline")
  })

  test("host repo has no .beads scaffold directory", async () => {
    expect(existsSync(join(hostDir, ".beads"))).toBe(false)
  })

  test("host repo working tree shows no untracked files", async () => {
    const { stdout } = await run("git", ["status", "--porcelain"], {
      cwd: hostDir,
      env: cleanEnv(),
    })
    expect(stdout.trim()).toBe("")
  })

  test("host repo has no MERGE_MSG / index lockfile artifacts (bd never committed)", async () => {
    // bd's git invocations leave traces beyond the commit itself if
    // they reach far enough — guard against partial-failure pollution.
    // COMMIT_EDITMSG is intentionally NOT checked: git leaves it after
    // ANY commit (including the legitimate host-baseline commit in
    // beforeAll), so its presence isn't a pollution signal. The HEAD
    // SHA + log assertions above already catch any extra commit.
    const gitDir = join(hostDir, ".git")
    expect(existsSync(join(gitDir, "MERGE_MSG"))).toBe(false)
    expect(existsSync(join(gitDir, "index.lock"))).toBe(false)
    // If COMMIT_EDITMSG exists it must hold the host-baseline message,
    // not the bd scaffold one.
    if (existsSync(join(gitDir, "COMMIT_EDITMSG"))) {
      const editmsg = await readFile(join(gitDir, "COMMIT_EDITMSG"), "utf-8")
      expect(editmsg).not.toContain("bd init")
      expect(editmsg).not.toContain("initialize beads issue tracking")
    }
  })

  test("host repo's marker.txt content is unchanged (sanity)", async () => {
    const content = await readFile(join(hostDir, "marker.txt"), "utf-8")
    expect(content).toBe("host")
  })
})

// ─── Direct unit tests on the env-stripping helper ─────────────────────────
//
// The host-pollution invariant tests above only fire under conditions
// where bd's internal git ops actually try to commit (which depends on
// bd version, cwd-resolution, and pre-push-hook env shape). The unit
// tests below pin the contract directly: every GIT_* family member must
// be removed before the env is handed to runBd. If a refactor ever drops
// the strip — even partially — these fail loudly without needing the
// downstream invariant to be triggerable.

describe("_cleanEnvForTesting (bb-kvsy + bb-aeb2 strip surface)", () => {
  test("strips GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (the bb-aeb2 trio)", () => {
    const result = _cleanEnvForTesting({
      GIT_DIR: "/host/.git",
      GIT_WORK_TREE: "/host",
      GIT_INDEX_FILE: "/host/.git/index",
      PATH: "/usr/bin",
    })
    expect(result.GIT_DIR).toBeUndefined()
    expect(result.GIT_WORK_TREE).toBeUndefined()
    expect(result.GIT_INDEX_FILE).toBeUndefined()
    // Non-GIT_ keys MUST pass through.
    expect(result.PATH).toBe("/usr/bin")
  })

  test("strips GIT_AUTHOR_* / GIT_COMMITTER_* (the bb-kvsy trio bd's auto-export reads)", () => {
    const result = _cleanEnvForTesting({
      GIT_AUTHOR_NAME: "Hook Author",
      GIT_AUTHOR_EMAIL: "hook@local",
      GIT_COMMITTER_NAME: "Hook Committer",
      GIT_COMMITTER_EMAIL: "hook@local",
      USER: "alice",
    })
    expect(result.GIT_AUTHOR_NAME).toBeUndefined()
    expect(result.GIT_AUTHOR_EMAIL).toBeUndefined()
    expect(result.GIT_COMMITTER_NAME).toBeUndefined()
    expect(result.GIT_COMMITTER_EMAIL).toBeUndefined()
    expect(result.USER).toBe("alice")
  })

  test("strips GIT_OBJECT_DIRECTORY / GIT_NAMESPACE / GIT_LITERAL_PATHSPECS and other less-common variants", () => {
    const result = _cleanEnvForTesting({
      GIT_OBJECT_DIRECTORY: "/host/.git/objects",
      GIT_NAMESPACE: "refs/namespaces/foo/",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_REFLOG_ACTION: "commit",
      GIT_EDITOR: "vim",
    })
    expect(result.GIT_OBJECT_DIRECTORY).toBeUndefined()
    expect(result.GIT_NAMESPACE).toBeUndefined()
    expect(result.GIT_LITERAL_PATHSPECS).toBeUndefined()
    expect(result.GIT_REFLOG_ACTION).toBeUndefined()
    expect(result.GIT_EDITOR).toBeUndefined()
  })

  test("forgiving regex catches future GIT_* additions (no named-list maintenance)", () => {
    // Synthetic future variant — git ships new GIT_* vars across
    // releases. Pin the principle: any GIT_-prefixed key is stripped.
    const result = _cleanEnvForTesting({
      GIT_HYPOTHETICAL_FUTURE_VAR_2030: "should be stripped",
    })
    expect(result.GIT_HYPOTHETICAL_FUTURE_VAR_2030).toBeUndefined()
  })

  test("preserves non-GIT keys including the BD_NON_INTERACTIVE extra", () => {
    const result = _cleanEnvForTesting(
      { GIT_DIR: "/host/.git", PATH: "/usr/bin", HOME: "/Users/alice" },
      { BD_NON_INTERACTIVE: "1", BEADS_REGISTRY_PATH: "/tmp/registry.json" },
    )
    expect(result.GIT_DIR).toBeUndefined()
    expect(result.PATH).toBe("/usr/bin")
    expect(result.HOME).toBe("/Users/alice")
    expect(result.BD_NON_INTERACTIVE).toBe("1")
    expect(result.BEADS_REGISTRY_PATH).toBe("/tmp/registry.json")
  })

  test("does not mutate the parent env passed in", () => {
    const parent: NodeJS.ProcessEnv = { GIT_DIR: "/host/.git", PATH: "/usr/bin" }
    _cleanEnvForTesting(parent)
    // The original object must be untouched — the helper builds a copy.
    expect(parent.GIT_DIR).toBe("/host/.git")
    expect(parent.PATH).toBe("/usr/bin")
  })

  test("rejects key prefixes that LOOK like GIT_ but are different (e.g. GITHUB_TOKEN)", () => {
    // The /^GIT_/ regex matches "GIT_" exactly — GITHUB_, GITLAB_, etc.
    // must pass through. Pin so a future maintainer doesn't widen the
    // strip to match anything starting with "GIT".
    const result = _cleanEnvForTesting({
      GITHUB_TOKEN: "secret",
      GITLAB_CI: "true",
      GIT_DIR: "/host/.git",
    })
    expect(result.GIT_DIR).toBeUndefined()
    expect(result.GITHUB_TOKEN).toBe("secret")
    expect(result.GITLAB_CI).toBe("true")
  })

  test("returns an env with no remaining GIT_-prefixed keys (defense in depth)", () => {
    const parent: NodeJS.ProcessEnv = {}
    // Inject 20 random GIT_* keys to make the assertion meaningful even
    // if the named list above misses one.
    for (let i = 0; i < 20; i++) {
      parent[`GIT_FOO_${i}`] = `value-${i}`
    }
    const result = _cleanEnvForTesting(parent)
    for (const key of Object.keys(result)) {
      expect(key.startsWith("GIT_")).toBe(false)
    }
  })
})
