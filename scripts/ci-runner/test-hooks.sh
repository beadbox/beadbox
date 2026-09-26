#!/bin/bash
# Reds and controls for job-started.sh (beadbox-5p1). Runs the hook with
# synthetic job environments: every case that must be refused, and the admit
# controls that show the refusals are not a hook that refuses everything.
# The only change to the hook under test is RUNNER_HOME, pointed at a temp dir.
# Usage: scripts/ci-runner/test-hooks.sh [path/to/job-started.sh]
set -uo pipefail
HOOK_SRC="${1:-$(dirname "$0")/job-started.sh}"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
HOME_DIR="$T/home"
WORK="$HOME_DIR/actions-runner/_work"
mkdir -p "$WORK/_temp/_github_workflow" "$WORK/beadbox/beadbox"
sed "s|^readonly RUNNER_HOME=.*|readonly RUNNER_HOME=\"$HOME_DIR\"|" "$HOOK_SRC" > "$T/hook.sh"
# The hook reads the admissible table from its own directory.
cp "$(dirname "$HOOK_SRC")/admissible.sh" "$T/admissible.sh"
cp "$(dirname "$HOOK_SRC")/trusted-path.sh" "$T/trusted-path.sh"
# A PATH of root-owned, non-symlinked system dirs (on merged-/usr Linux /bin is
# a symlink, which the hook rightly refuses).
if [ -L /bin ]; then SYS_PATH=/usr/bin; else SYS_PATH=/usr/bin:/bin; fi
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
grep -q "^readonly RUNNER_HOME=\"$HOME_DIR\"" "$T/hook.sh" || { echo "harness: RUNNER_HOME not substituted"; exit 2; }

SHA=0123456789abcdef0123456789abcdef01234567
EV="$WORK/_temp/_github_workflow/event.json"
payload() { printf '{"ref":"%s","repository":{"full_name":"%s"}%s}\n' "$1" "${2:-beadbox/beadbox}" "${3:-}" > "$EV"; }

pass=0; fail=0
# run <expect: admit|refuse> <label> [VAR=value ...]  (unset a var with VAR=@unset)
run() {
  local expect=$1 label=$2; shift 2
  local -a env=(
    "GITHUB_REPOSITORY=beadbox/beadbox" "GITHUB_EVENT_NAME=push" "GITHUB_REF=refs/tags/v1.2.3"
    "GITHUB_WORKFLOW_REF=beadbox/beadbox/.github/workflows/release.yml@refs/tags/v1.2.3"
    "GITHUB_WORKFLOW_SHA=$SHA" "GITHUB_SHA=$SHA" "GITHUB_EVENT_PATH=$EV"
    "GITHUB_WORKSPACE=$WORK/beadbox/beadbox" "PATH=$SYS_PATH"
  )
  local kv k
  for kv in "$@"; do
    k=${kv%%=*}
    env=("${env[@]/#$k=*/}")
    [ "${kv#*=}" = "@unset" ] || env+=("$kv")
  done
  local -a clean_env=()
  for kv in "${env[@]}"; do [ -n "$kv" ] && clean_env+=("$kv"); done
  touch "$WORK/beadbox/beadbox/leftover"
  local got
  if env -i "${clean_env[@]}" /bin/bash "$T/hook.sh" >"$T/out" 2>&1; then got=admit; else got=refuse; fi
  if [ "$got" = "$expect" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL [$label]: expected $expect, got $got: $(tail -1 "$T/out")"; fi
  # F2: a refusal is always explained (and logged), never a bare nonzero exit.
  if [ "$got" = refuse ] && [ "$expect" = refuse ] && ! grep -q "beadbox runner hook refused:" "$T/out"; then
    fail=$((fail + 1)); echo "FAIL [$label]: refused without the refusal message: $(tail -1 "$T/out")"
  fi
  if [ "$got" = admit ] && [ -e "$WORK/beadbox/beadbox/leftover" ]; then fail=$((fail + 1)); echo "FAIL [$label]: admitted but the work dir was not emptied"; fi
}

MAINWF=beadbox/beadbox/.github/workflows/release.yml
# Admit controls.
payload refs/tags/v1.2.3
run admit "push tag v1.2.3"
payload refs/tags/v0.27.2-rc.4
run admit "push tag v0.27.2-rc.4" GITHUB_REF=refs/tags/v0.27.2-rc.4 GITHUB_WORKFLOW_REF=$MAINWF@refs/tags/v0.27.2-rc.4
BUILDWF=beadbox/beadbox/.github/workflows/build-main.yml
payload refs/heads/main
run admit "main build through build-main.yml" GITHUB_REF=refs/heads/main GITHUB_WORKFLOW_REF=$BUILDWF@refs/heads/main

# Lookalikes of the two admitted triples: each is one value away from one of them.
payload refs/tags/v1.2.3
run refuse "build-main.yml on a release tag" GITHUB_WORKFLOW_REF=$BUILDWF@refs/tags/v1.2.3
payload refs/heads/main
run refuse "release.yml on main" GITHUB_REF=refs/heads/main GITHUB_WORKFLOW_REF=$MAINWF@refs/heads/main
payload refs/heads/feature
run refuse "build-main.yml on another branch" GITHUB_REF=refs/heads/feature GITHUB_WORKFLOW_REF=$BUILDWF@refs/heads/feature
payload refs/tags/v1.2.3
run refuse "main build whose payload names a tag" GITHUB_REF=refs/heads/main GITHUB_WORKFLOW_REF=$BUILDWF@refs/heads/main
payload refs/heads/main
run refuse "build-main.yml@main but the ref is a tag" GITHUB_REF=refs/tags/v1.2.3 GITHUB_WORKFLOW_REF=$BUILDWF@refs/heads/main
run refuse "main build dispatched" GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF=refs/heads/main GITHUB_WORKFLOW_REF=$BUILDWF@refs/heads/main
for r in refs/heads/main2 refs/heads/main/x refs/heads/mainx; do
  payload "$r"
  run refuse "build-main.yml on [$r] (main, unanchored)" "GITHUB_REF=$r" "GITHUB_WORKFLOW_REF=$BUILDWF@$r"
done

payload refs/tags/v1.2.3
# H2: events. These must be refused ON THE EVENT (the day-one hook check
# relies on that reason), not only by a later check.
for e in pull_request pull_request_target workflow_dispatch workflow_run schedule issue_comment repository_dispatch; do
  run refuse "event $e" GITHUB_EVENT_NAME=$e
  if ! grep -q "refused: event (" "$T/out"; then
    fail=$((fail + 1)); echo "FAIL [event $e]: refused, but not on the event: $(tail -1 "$T/out")"
  fi
done
# H1: repository.
run refuse "fork repository" GITHUB_REPOSITORY=someone/beadbox
# H3: refs, including unanchored tag shapes.
for r in refs/heads/main refs/heads/feature refs/heads/main2 refs/pull/1/merge refs/tags/vx refs/tags/v1.2 refs/tags/v1.2.3-evil \
  refs/tags/v1.2.3/.. refs/tags/xv1.2.3 refs/heads/refs/tags/v1.2.3 "refs/tags/v1.2.3
x" refs/tags/v1.2.3-rc.1x refs/heads/main/x; do
  payload "$r"
  run refuse "ref [$r]" "GITHUB_REF=$r" "GITHUB_WORKFLOW_REF=$MAINWF@$r"
done
payload refs/tags/v1.2.3
# H4: workflow ref.
run refuse "other workflow" GITHUB_WORKFLOW_REF=beadbox/beadbox/.github/workflows/quality-gates.yml@refs/tags/v1.2.3
run refuse "release.yml from another ref" GITHUB_WORKFLOW_REF=$MAINWF@refs/tags/v1.2.4
run refuse "release.yml from a fork" GITHUB_WORKFLOW_REF=someone/beadbox/.github/workflows/release.yml@refs/tags/v1.2.3
run refuse "workflow_ref without ref" GITHUB_WORKFLOW_REF=$MAINWF
# H5: workflow sha.
run refuse "workflow_sha differs" GITHUB_WORKFLOW_SHA=fedcba9876543210fedcba9876543210fedcba98
run refuse "sha not 40-hex" GITHUB_SHA=main GITHUB_WORKFLOW_SHA=main
# H6: PR-only values.
run refuse "head_ref present" GITHUB_HEAD_REF=feature
run refuse "base_ref present" GITHUB_BASE_REF=main
# H7: payload.
payload refs/tags/v1.2.4
run refuse "payload ref disagrees"
payload refs/tags/v1.2.3 someone/beadbox
run refuse "payload repo disagrees"
payload refs/tags/v1.2.3 beadbox/beadbox ',"pull_request":{"number":1}'
run refuse "payload has pull_request"
payload refs/tags/v1.2.3
# FIX-1: a VALID payload anywhere but the runner's own file is refused,
# including inside an action tarball unpacked under _work before the hook.
cp "$EV" "$T/outside.json"
run refuse "valid payload outside the work dir" "GITHUB_EVENT_PATH=$T/outside.json"
mkdir -p "$WORK/_actions/o/r/0123abc"
cp "$EV" "$WORK/_actions/o/r/0123abc/event.json"
run refuse "valid payload planted in an action tarball" "GITHUB_EVENT_PATH=$WORK/_actions/o/r/0123abc/event.json"
cp "$EV" "$WORK/_temp/other.json"
run refuse "valid payload at another _temp path" "GITHUB_EVENT_PATH=$WORK/_temp/other.json"
# The runner's own path, with bad content.
printf 'not json' > "$EV"
run refuse "payload not JSON"
rm -f "$EV"
run refuse "payload missing"
payload refs/tags/v1.2.3
mv "$EV" "$WORK/_temp/real.json" && ln -s "$WORK/_temp/real.json" "$EV"
run refuse "payload is a symlink"
rm -f "$EV" && payload refs/tags/v1.2.3
run refuse "workspace outside the work dir" GITHUB_WORKSPACE=/tmp
# H0: PATH. A dir another account could write, or a relative/empty entry, is
# refused; the runner's own dirs (under its home) are skipped.
mkdir -p "$T/userbin" "$HOME_DIR/tools/bin"
chmod 755 "$T/userbin"
run refuse "PATH with a dir not owned by root" "PATH=$T/userbin:$SYS_PATH"
run refuse "PATH with an empty entry (cwd)" "PATH=:$SYS_PATH"
run refuse "PATH with a relative entry" "PATH=bin:$SYS_PATH"
run refuse "PATH with a missing dir" "PATH=/nonexistent/bin:$SYS_PATH"
run admit "PATH with the runner's own dir (skipped)" "PATH=$HOME_DIR/tools/bin:$SYS_PATH"
# The hook must not run its own commands through the PATH it is checking: a
# planted 'find' first on PATH must never execute, and the job is refused.
mkdir -p "$T/planted" && chmod 755 "$T/planted"
printf '#!/bin/sh\ntouch "%s/PLANTED_RAN"\nexit 0\n' "$T" > "$T/planted/find"
chmod 755 "$T/planted/find"
for tool in dirname tr cut ls jq logger; do cp "$T/planted/find" "$T/planted/$tool"; done
run refuse "PATH with a planted find/dirname/tr (untrusted)" "PATH=$T/planted:$SYS_PATH"
if [ -e "$T/PLANTED_RAN" ]; then fail=$((fail + 1)); echo "FAIL [planted tool]: the hook executed a program from the PATH it was checking"; fi
# F1: every required value unset, and empty.
for v in GITHUB_REPOSITORY GITHUB_EVENT_NAME GITHUB_REF GITHUB_WORKFLOW_REF GITHUB_WORKFLOW_SHA GITHUB_SHA GITHUB_EVENT_PATH GITHUB_WORKSPACE PATH; do
  run refuse "$v unset" "$v=@unset"
  run refuse "$v empty" "$v="
done

# An unexpected error after the checks (a work dir entry it cannot delete)
# must still refuse, with the message: fail closed.
mkdir -p "$WORK/beadbox/beadbox/locked/inner" && chmod 500 "$WORK/beadbox/beadbox/locked"
run refuse "work dir cannot be emptied"
chmod 700 "$WORK/beadbox/beadbox/locked" && rm -rf "$WORK/beadbox/beadbox/locked"
# An unreadable work dir must not read as "empty".
chmod 300 "$WORK/beadbox/beadbox"
run refuse "work dir unreadable"
chmod 700 "$WORK/beadbox/beadbox"

echo "hook tests: $pass passed, $fail failed"

# ---------------------------------------------------------------------------
# trusted-path.sh: what the signing job may execute. The owner set is a
# parameter so these run without root: here it is {root, this user}, over a
# tree under $HOME (whose ancestors are root- or user-owned, not shared).
# shellcheck source=scripts/ci-runner/trusted-path.sh
source "$(dirname "$HOOK_SRC")/trusted-path.sh"
tpass=0; tfail=0
ME=$(id -un)
B=$(mktemp -d "$HOME/.beadbox-trust-test.XXXXXX")
chmod 755 "$B"
# tcase <expect: trusted|untrusted> <label> <command...>
tcase() {
  local expect=$1 label=$2 why got
  shift 2
  why=$("$@")
  if [ -z "$why" ]; then got=trusted; else got=untrusted; fi
  if [ "$got" = "$expect" ]; then tpass=$((tpass + 1)); else tfail=$((tfail + 1)); echo "FAIL trust [$label]: expected $expect, got $got ($why)"; fi
}
mkdir -p "$B/good" "$B/gw" "$B/ow" "$B/wparent/child" "$B/skip/x" "$B/skipper"
chmod 755 "$B/good" "$B/wparent/child"
chmod 775 "$B/gw" "$B/wparent" "$B/skip/x" "$B/skipper"
chmod 757 "$B/ow"
ln -s "$B/good" "$B/link"
tcase trusted "own-set dir" untrusted_dir "$B/good" root "$ME"
tcase untrusted "group-writable dir" untrusted_dir "$B/gw" root "$ME"
tcase untrusted "other-writable dir" untrusted_dir "$B/ow" root "$ME"
tcase untrusted "symlinked dir" untrusted_dir "$B/link" root "$ME"
tcase untrusted "dir under a group-writable parent" untrusted_dir "$B/wparent/child" root "$ME"
tcase untrusted "dir not owned by root (production owner set)" untrusted_dir "$B/good" root
tcase untrusted "missing dir" untrusted_dir "$B/none" root "$ME"
tcase untrusted "relative dir" untrusted_dir "good" root "$ME"
tcase trusted "PATH of trusted dirs" untrusted_path_entries "$B/good:$SYS_PATH" -- root "$ME"
tcase untrusted "PATH with a leading empty entry" untrusted_path_entries ":$B/good" -- root "$ME"
tcase untrusted "PATH with an empty middle entry" untrusted_path_entries "$B/good::$SYS_PATH" -- root "$ME"
tcase untrusted "PATH with a trailing empty entry" untrusted_path_entries "$B/good:" -- root "$ME"
tcase untrusted "PATH with a group-writable dir" untrusted_path_entries "$B/good:$B/gw" -- root "$ME"
tcase trusted "PATH entry under a skip prefix" untrusted_path_entries "$B/skip/x:$B/good" "$B/skip" -- root "$ME"
tcase untrusted "PATH entry that only starts like the skip prefix" untrusted_path_entries "$B/skipper:$B/good" "$B/skip" -- root "$ME"
# The toolchain tree, rustup-style.
TC="$B/tc"
mkdir -p "$TC/rustup/toolchains/x/bin" "$TC/cargo/bin"
printf '#!/bin/sh\n' > "$TC/cargo/bin/rustup" && chmod 755 "$TC/cargo/bin/rustup"
ln -s rustup "$TC/cargo/bin/cargo"
printf 'x' > "$TC/rustup/toolchains/x/bin/rustc" && chmod 755 "$TC/rustup/toolchains/x/bin/rustc"
chmod -R go-w "$TC"
tcase trusted "toolchain tree (with rustup proxy links)" untrusted_tree "$TC" root "$ME"
chmod g+w "$TC/rustup/toolchains/x/bin/rustc"
tcase untrusted "toolchain with a group-writable file" untrusted_tree "$TC" root "$ME"
chmod g-w "$TC/rustup/toolchains/x/bin/rustc"
chmod o+w "$TC/rustup/toolchains"
tcase untrusted "toolchain with an other-writable dir" untrusted_tree "$TC" root "$ME"
chmod o-w "$TC/rustup/toolchains"
ln -s /usr/bin/true "$TC/cargo/bin/evil"
tcase untrusted "toolchain symlink leaving its dir" untrusted_tree "$TC" root "$ME"
rm "$TC/cargo/bin/evil"
ln -s ../../rustup "$TC/cargo/bin/evil"
tcase untrusted "toolchain symlink with a path" untrusted_tree "$TC" root "$ME"
rm "$TC/cargo/bin/evil"
mkdir "$TC/cargo/bin/adir" && chmod 755 "$TC/cargo/bin/adir" && ln -s adir "$TC/cargo/bin/evil"
tcase untrusted "toolchain symlink to a dir beside it" untrusted_tree "$TC" root "$ME"
rm -rf "$TC/cargo/bin/evil" "$TC/cargo/bin/adir"
mkdir "$TC/cargo/bin/sub" && printf 'x' > "$TC/cargo/bin/sub/real" && chmod 755 "$TC/cargo/bin/sub" "$TC/cargo/bin/sub/real"
ln -s sub/real "$TC/cargo/bin/evil"
tcase untrusted "toolchain symlink into a subdir (a path, even to a file)" untrusted_tree "$TC" root "$ME"
rm -rf "$TC/cargo/bin/evil" "$TC/cargo/bin/sub"
tcase untrusted "toolchain not owned by root (production owner set)" untrusted_tree "$TC" root
# check-runner-path.sh (the release.yml step): refuses a PATH led by planted
# tools without ever executing one of them.
mkdir -p "$B/planted" && chmod 755 "$B/planted"
printf '#!/bin/sh\ntouch "%s/CHECK_PLANTED_RAN"\nexit 0\n' "$B" > "$B/planted/find"
for tool in dirname readlink head sed tr; do cp "$B/planted/find" "$B/planted/$tool"; done
chmod 755 "$B"/planted/*
if env -i HOME="$HOME" RUNNER_TEMP="$T" PATH="$B/planted:$SYS_PATH" /bin/bash "$(dirname "$HOOK_SRC")/check-runner-path.sh" "$B/planted:$SYS_PATH" "$TC" >"$T/crp.out" 2>&1; then
  tfail=$((tfail + 1)); echo "FAIL trust [check-runner-path refuses planted PATH]: it passed"
elif [ -e "$B/CHECK_PLANTED_RAN" ]; then
  tfail=$((tfail + 1)); echo "FAIL trust [check-runner-path ran a planted tool]"
else
  tpass=$((tpass + 1))
fi
chmod -R u+w "$B" && rm -rf "$B"
# The supervisor's literal job PATH: root-owned dirs only, $LIBEXEC/bin first,
# nothing another account can write. Its system dirs must pass the production
# check here where they are real dirs (macOS, where the runner runs).
CYCLE_PATH=$(sed -n 's/^[[:space:]]*PATH="\(.*\)" \\$/\1/p' "$(dirname "$HOOK_SRC")/runner-cycle.sh")
# shellcheck disable=SC2016 # literal $LIBEXEC / $HOME text in the script
case "$CYCLE_PATH" in
  '$LIBEXEC/bin:'*) tpass=$((tpass + 1)) ;;
  *) tfail=$((tfail + 1)); echo "FAIL trust [runner PATH starts with \$LIBEXEC/bin]: '$CYCLE_PATH'" ;;
esac
# shellcheck disable=SC2016 # literal $HOME text in the script
case ":$CYCLE_PATH:" in
  *:/usr/local/bin:* | *:/opt/homebrew/bin:* | *homebrew* | *'$HOME'* | *::*) tfail=$((tfail + 1)); echo "FAIL trust [runner PATH has a shared dir]: '$CYCLE_PATH'" ;;
  *) tpass=$((tpass + 1)) ;;
esac
if [ ! -L /bin ]; then
  tcase trusted "runner PATH's system dirs (production owner set)" untrusted_path_entries "${CYCLE_PATH#\$LIBEXEC/bin:}" -- root
fi
echo "trust tests: $tpass passed, $tfail failed"

# ---------------------------------------------------------------------------
# pick-macos-runner.sh: every uncertain answer must be the GitHub fallback.
PICK="$(dirname "$HOOK_SRC")/pick-macos-runner.sh"
mkdir -p "$T/bin"
# A fake gh: FAKE_GH=fail exits 1; otherwise it applies the real jq program to
# the canned runners document in $FAKE_RUNNERS, as gh api --jq would.
cat > "$T/bin/gh" <<'GH'
#!/bin/bash
[ "${FAKE_GH:-}" = fail ] && exit 1
[ "${FAKE_GH:-}" = two-pages ] && { printf '0\n1\n'; exit 0; }
while [ $# -gt 0 ]; do [ "$1" = --jq ] && { shift; jq_prog=$1; }; shift; done
/usr/bin/jq -r "$jq_prog" "$FAKE_RUNNERS"
GH
chmod 755 "$T/bin/gh"
runners() { printf '{"total_count":1,"runners":[{"status":"%s","busy":%s,"labels":[{"name":"%s"}]}]}' "$1" "$2" "$3" > "$T/runners.json"; }
ppass=0; pfail=0
# pcase <expected runs_on> <label> [VAR=value ...]
pcase() {
  local want=$1 label=$2; shift 2
  : > "$T/gh_out"
  env -i PATH="$T/bin:/usr/bin:/bin" GITHUB_OUTPUT="$T/gh_out" GITHUB_REPOSITORY=beadbox/beadbox GITHUB_EVENT_NAME=push \
    GITHUB_REF=refs/tags/v1.2.3 GITHUB_WORKFLOW_REF=beadbox/beadbox/.github/workflows/release.yml@refs/tags/v1.2.3 \
    FAKE_RUNNERS="$T/runners.json" "$@" /bin/bash "$PICK" > "$T/pick_log" 2>&1
  local rc=$? got
  got=$(sed -n 's/^runs_on=//p' "$T/gh_out")
  if [ "$rc" -eq 0 ] && [ "$got" = "$want" ]; then ppass=$((ppass + 1)); else pfail=$((pfail + 1)); echo "FAIL pick [$label]: rc=$rc runs_on=$got want=$want ($(cat "$T/pick_log"))"; fi
}
GHR='"macos-14"'; SELF='["beadbox-macos-release"]'
runners online false beadbox-macos-release
pcase "$SELF" "online and idle" GH_TOKEN=t
pcase "$GHR" "no token" GH_TOKEN=
pcase "$GHR" "workflow_dispatch, runner idle" GH_TOKEN=t GITHUB_EVENT_NAME=workflow_dispatch
pcase "$GHR" "workflow_dispatch, forced self-hosted" MACOS_RUNNER=self-hosted GITHUB_EVENT_NAME=workflow_dispatch
pcase "$GHR" "forced github" GH_TOKEN=t MACOS_RUNNER=github
pcase "$SELF" "forced self-hosted" MACOS_RUNNER=self-hosted
pcase "$GHR" "unknown override value" GH_TOKEN=t MACOS_RUNNER=yes
pcase "$GHR" "API error" GH_TOKEN=t FAKE_GH=fail
pcase "$SELF" "main build through build-main.yml, runner idle" GH_TOKEN=t GITHUB_REF=refs/heads/main \
  GITHUB_WORKFLOW_REF=beadbox/beadbox/.github/workflows/build-main.yml@refs/heads/main
pcase "$GHR" "release.yml on main (the hook would refuse)" GH_TOKEN=t GITHUB_REF=refs/heads/main \
  GITHUB_WORKFLOW_REF=beadbox/beadbox/.github/workflows/release.yml@refs/heads/main
pcase "$GHR" "build-main.yml on a tag (the hook would refuse)" MACOS_RUNNER=self-hosted \
  GITHUB_WORKFLOW_REF=beadbox/beadbox/.github/workflows/build-main.yml@refs/tags/v1.2.3
pcase "$GHR" "build-main.yml on another branch" GH_TOKEN=t GITHUB_REF=refs/heads/feature \
  GITHUB_WORKFLOW_REF=beadbox/beadbox/.github/workflows/build-main.yml@refs/heads/feature
runners online true beadbox-macos-release
pcase "$GHR" "busy" GH_TOKEN=t
runners offline false beadbox-macos-release
pcase "$GHR" "offline" GH_TOKEN=t
runners online false some-other-label
pcase "$GHR" "only another label online" GH_TOKEN=t
printf '{"runners":' > "$T/runners.json"
pcase "$GHR" "garbled API answer" GH_TOKEN=t
pcase "$GHR" "one count per page (not a single number)" GH_TOKEN=t FAKE_GH=two-pages
echo "picker tests: $ppass passed, $pfail failed"

# ---------------------------------------------------------------------------
# runner-cycle.sh step 0: no process of the runner user may survive into the
# next job. The real primitives act on the dedicated runner uid; here they are
# replaced by ones scoped to a process this test starts under a unique name,
# so the test can never touch anything else on the machine.
CYCLE="$(dirname "$HOOK_SRC")/runner-cycle.sh"
cpass=0; cfail=0
TAG_NAME="beadbox-cycle-test-$$-$RANDOM"
start_leftover() { (exec -a "$TAG_NAME" sleep 300) & LEFTOVER=$!; }
# ccase <expect: clear|refuse> <label> <kill-works: yes|no>
ccase() {
  local expect=$1 label=$2 kill_works=$3 got
  start_leftover
  # shellcheck disable=SC2329 # the overrides below are called by clear_runner_user
  got=$(
    set +eu
    # shellcheck source=/dev/null
    source "$CYCLE"
    log() { :; }
    sleep() { :; }
    runner_procs() { /usr/bin/pgrep -f "$TAG_NAME"; }
    if [ "$kill_works" = yes ]; then
      kill_runner_procs() { kill -KILL "$LEFTOVER" 2>/dev/null; wait "$LEFTOVER" 2>/dev/null; }
    else
      kill_runner_procs() { :; }  # a process that escaped the kill
    fi
    if clear_runner_user; then echo clear; else echo refuse; fi
  )
  kill -KILL "$LEFTOVER" 2>/dev/null; wait "$LEFTOVER" 2>/dev/null
  if [ "$got" = "$expect" ]; then cpass=$((cpass + 1)); else cfail=$((cfail + 1)); echo "FAIL cycle [$label]: expected $expect, got $got"; fi
}
ccase clear "leftover process ended: the next runner may start" yes
ccase refuse "leftover process survives: no runner starts" no
# Step 0's home reset: only Library/Keychains survives, including planted
# build config (cargo reads .cargo/config.toml from every ancestor of the
# build dir), package caches, rc files and LaunchAgents.
H="$T/runner-home"
mkdir -p "$H/.cargo/registry" "$H/.bun/install/cache" "$H/Library/Keychains" "$H/Library/LaunchAgents" "$H/Library/Caches" "$H/.config"
printf '[build]\nrustc-wrapper = "/tmp/evil"\n' > "$H/.cargo/config.toml"
touch "$H/.zshrc" "$H/.npmrc" "$H/Library/Keychains/login.keychain-db" "$H/Library/LaunchAgents/x.plist" "$H/.hidden"
# shellcheck disable=SC2329 # log() is called by reset_runner_home
got=$(
  set +eu
  # shellcheck source=/dev/null
  source "$CYCLE"
  log() { :; }
  if reset_runner_home "$H"; then echo ok; else echo refused; fi
)
rest=$(cd "$H" && find . -mindepth 1 | sort | tr '\n' ' ')
if [ "$got" = ok ] && [ "$rest" = "./Library ./Library/Keychains ./Library/Keychains/login.keychain-db " ]; then
  cpass=$((cpass + 1))
else
  cfail=$((cfail + 1)); echo "FAIL cycle [home reset keeps only Library/Keychains]: $got, left: $rest"
fi
# ...and refuses when something cannot be removed.
mkdir -p "$H/stuck/inner" && chmod 500 "$H/stuck"
# shellcheck disable=SC2329 # log() is called by reset_runner_home
got=$(
  set +eu
  # shellcheck source=/dev/null
  source "$CYCLE"
  log() { :; }
  if reset_runner_home "$H"; then echo ok; else echo refused; fi
)
chmod 700 "$H/stuck"
if [ "$got" = refused ]; then cpass=$((cpass + 1)); else cfail=$((cfail + 1)); echo "FAIL cycle [home reset refuses when it cannot empty]: $got"; fi
# The main loop must gate every cycle on step 0 (both halves), before the JIT config.
# shellcheck disable=SC2016 # a literal line of the script, not an expansion
if grep -q '^    until clear_runner_user && reset_runner_home "$RUNNER_HOME"; do sleep 60; done$' "$CYCLE" \
  && [ "$(grep -n 'until clear_runner_user' "$CYCLE" | cut -d: -f1)" -lt "$(grep -n 'generate-jitconfig' "$CYCLE" | cut -d: -f1)" ]; then
  cpass=$((cpass + 1))
else
  cfail=$((cfail + 1)); echo "FAIL cycle [main loop gates on step 0 before the JIT config]"
fi
if pgrep -f "$TAG_NAME" >/dev/null; then cfail=$((cfail + 1)); echo "FAIL cycle: the test left its own process running"; fi
# C-4: no build state on the release runner survives a job. release.yml must
# not name a persistent build dir, and on that runner cargo's home and bun's
# cache are per job, Rust comes from the root-owned toolchain, and the Actions
# cache is used on GitHub-hosted runners only.
REL="$REPO_ROOT/.github/workflows/release.yml"
# shellcheck disable=SC2016 # the greps in this block look for literal workflow text
if [ -f "$REL" ]; then
  c4=ok
  grep -qE 'beadbox-runner-cache|CARGO_TARGET_DIR' "$REL" && c4="names a persistent build dir"
  grep -q 'echo "CARGO_HOME=$RUNNER_TEMP/cargo-home"' "$REL" || c4="no per-job CARGO_HOME"
  grep -q 'echo "BUN_INSTALL_CACHE_DIR=$RUNNER_TEMP/bun-cache"' "$REL" || c4="no per-job bun cache"
  grep -q 'echo "RUSTUP_HOME=$TOOLS/rustup"' "$REL" || c4="no root-owned toolchain"
  grep -q 'bash scripts/ci-runner/check-runner-path.sh "$TOOLS/cargo/bin:$PATH" "$TOOLS"' "$REL" || c4="no PATH/toolchain trust check"
  [ "$(grep -A1 -E 'name: (Rust cache|Setup Rust)$' "$REL" | grep -c "if: runner.environment == 'github-hosted'")" -ge 2 ] || c4="GitHub cache/toolchain not limited to hosted runners"
  if [ "$c4" = ok ]; then cpass=$((cpass + 1)); else cfail=$((cfail + 1)); echo "FAIL cycle [C-4 release.yml]: $c4"; fi
else
  cfail=$((cfail + 1)); echo "FAIL cycle [C-4]: release.yml not found at $REL"
fi
echo "cycle tests: $cpass passed, $cfail failed"
[ "$fail" -eq 0 ] && [ "$tfail" -eq 0 ] && [ "$pfail" -eq 0 ] && [ "$cfail" -eq 0 ]
