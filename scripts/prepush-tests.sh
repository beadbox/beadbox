#!/usr/bin/env bash
# Tests for the pre-push hook: only the ones related to what is being pushed
# (beadbox-gxr). CI Quality Gates still runs the full suite on every push.
#
# Mechanism: bun's own related-test mode, `bun test --changed=<base>`, which
# selects the test files whose import graph reaches a file changed since
# <base>. <base> is the commit the remote branch is at now (from the refs git
# hands the hook), so "changed" means "what this push adds". Server test
# files are split into shards run in parallel, each shard filtered by
# --changed, because most server tests spawn real bd/Dolt and are I/O-bound.
# The security suite (*.security.test.ts) runs on every push regardless: its
# tests scan source files instead of importing them, so --changed cannot see
# what they cover, and together they take ~10s.
#
# FAIL SAFE: whenever the related set cannot be trusted, run the FULL suite
# (still sharded). That is the case when the base is unknown or not a single
# commit, when what is pushed is not the checked-out HEAD, when git cannot
# list the changes, or when a changed file affects tests without being
# imported by them: package manifests and lockfiles, bunfig/tsconfig, this
# script and the hooks, test preloads and fixtures, and the sidecar entry
# (packages/server/src/index.ts, which tests spawn by path).
#
# Input: PUSH_SPECS, one "<remote sha> <local sha>" line per pushed ref, set
# by .husky/_is-deletion-only-push.sh from the refs git gives the hook.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

ZERO=0000000000000000000000000000000000000000
SHARDS=${BEADBOX_PREPUSH_SHARDS:-4}
LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/beadbox-prepush.XXXXXX")

mode="related"
reason=""
full() { mode="full"; reason="$1"; }

# --- the base: the single commit the remote is at, for a push of HEAD -------
base=""
head=$(git rev-parse HEAD 2>/dev/null) || full "cannot resolve HEAD"
specs=()
while IFS= read -r line; do [ -n "$line" ] && specs+=("$line"); done <<<"${PUSH_SPECS:-}"
for spec in "${specs[@]+"${specs[@]}"}"; do
  read -r remote_sha local_sha <<<"$spec"
  [ "$local_sha" = "$ZERO" ] && continue # a deletion tests nothing
  if [ "$local_sha" != "$head" ]; then full "pushing ${local_sha:0:8}, which is not the checked-out HEAD"; break; fi
  candidate="$remote_sha"
  if [ "$candidate" = "$ZERO" ]; then
    # A new branch: compare against where it left main.
    candidate=$(git merge-base HEAD origin/main 2>/dev/null) || { full "new ref with no merge-base against origin/main"; break; }
  fi
  if ! git cat-file -e "${candidate}^{commit}" 2>/dev/null; then full "base ${candidate:0:8} is not in this clone (fetch first)"; break; fi
  if [ -n "$base" ] && [ "$base" != "$candidate" ]; then full "pushed refs have different bases"; break; fi
  base="$candidate"
done
[ "$mode" = "related" ] && [ -z "$base" ] && full "no pushed ref to compare against"

# --- what changed, and whether a related set can be trusted -----------------
changed=""
if [ "$mode" = "related" ]; then
  # Against the working tree, like `bun test --changed`: uncommitted edits
  # only add tests, never remove them.
  if ! changed=$(git diff --name-only "$base" 2>/dev/null); then
    full "git diff against ${base:0:8} failed"
  fi
fi
if [ "$mode" = "related" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      package.json | */package.json | bun.lock | bun.lockb | bunfig.toml | */bunfig.toml | \
        tsconfig*.json | */tsconfig*.json | .husky/* | scripts/* | \
        packages/*/src/__tests__/_* | packages/*/src/__tests__/fixtures/* | \
        packages/server/src/index.ts)
        full "$f affects tests without being imported by them"
        break
        ;;
    esac
  done <<<"$changed"
fi

server_changed=false
client_changed=false
if [ "$mode" = "related" ]; then
  grep -q '^packages/server/' <<<"$changed" && server_changed=true
  grep -q '^packages/client/' <<<"$changed" && client_changed=true
  # The client imports server types, and handler signatures reach it; tsc in
  # the hook covers that. A server change selects client tests only if they
  # import it, which --changed decides.
  if ! $server_changed && ! $client_changed; then
    echo "[prepush-tests] nothing under packages/ changed since ${base:0:8}; no tests to run (CI runs the full suite)"
    exit 0
  fi
fi

if [ "$mode" = "full" ]; then
  echo "[prepush-tests] FULL suite: $reason"
  changed_flag=""
else
  echo "[prepush-tests] related tests for changes since ${base:0:8} (bun test --changed)"
  changed_flag="--changed=$base"
fi

# --- run -------------------------------------------------------------------
pids=()
labels=()
run() { # label, dir, bun test args...
  local label=$1 dir=$2
  shift 2
  (cd "$dir" && bun test "$@") >"$LOGDIR/$label.log" 2>&1 &
  pids+=($!)
  labels+=("$label")
}

server_tests=()
security_tests=()
for f in packages/server/src/__tests__/*.test.ts; do
  rel=${f#packages/server/}
  case "$f" in
    *.security.test.ts) security_tests+=("$rel") ;;
    *) server_tests+=("$rel") ;;
  esac
done
changed_args=()
[ -n "$changed_flag" ] && changed_args=("$changed_flag")

if [ "$mode" = "full" ] || $server_changed || $client_changed; then
  for ((i = 0; i < SHARDS; i++)); do
    shard=()
    for ((j = i; j < ${#server_tests[@]}; j += SHARDS)); do shard+=("${server_tests[$j]}"); done
    [ ${#shard[@]} -eq 0 ] && continue
    run "server-$i" packages/server "${changed_args[@]+"${changed_args[@]}"}" "${shard[@]}"
  done
  run "server-security" packages/server "${security_tests[@]}"
fi
run "client" packages/client "${changed_args[@]+"${changed_args[@]}"}"

failed=()
for idx in "${!pids[@]}"; do
  if ! wait "${pids[$idx]}"; then failed+=("${labels[$idx]}"); fi
done

for label in "${labels[@]}"; do
  summary=$(grep -E '^Ran [0-9]+ tests' "$LOGDIR/$label.log" | tail -1)
  echo "[prepush-tests] $label: ${summary:-no summary}"
done

if [ ${#failed[@]} -gt 0 ]; then
  for label in "${failed[@]}"; do
    echo "[prepush-tests] ---- $label FAILED ----"
    grep -E '^\(fail\)|error:|Expected|Received' "$LOGDIR/$label.log" | head -40
    echo "[prepush-tests] full log: $LOGDIR/$label.log"
  done
  exit 1
fi
rm -rf "$LOGDIR"
exit 0
