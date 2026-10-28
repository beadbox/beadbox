#!/usr/bin/env bash
# Rust compile check for the pre-push hook (beadbox-mol-0zm). Rust coverage
# runs nightly (.github/workflows/nightly.yml), not on push, so this is what
# stops a src-tauri compile error before it reaches main: `cargo check` on
# the host crate, run only when the push changes something under src-tauri/.
# On a warm local target dir it takes seconds; a cold one compiles the
# dependency tree once.
#
# FAIL SAFE: when the pushed range cannot be read (unknown base, a new ref
# with no merge-base against origin/main, a failing git diff), the check
# runs. A deletion-only push never gets here: the hook exits before its gates.
#
# Input: PUSH_SPECS, one "<remote sha> <local sha>" line per pushed ref, set
# by .husky/_is-deletion-only-push.sh from the refs git gives the hook.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

ZERO=0000000000000000000000000000000000000000
say() { echo "[prepush-cargo] $*"; }

why=""
specs=()
while IFS= read -r line; do [ -n "$line" ] && specs+=("$line"); done <<<"${PUSH_SPECS:-}"
for spec in "${specs[@]+"${specs[@]}"}"; do
  read -r remote_sha local_sha <<<"$spec"
  [ "$local_sha" = "$ZERO" ] && continue
  base="$remote_sha"
  if [ "$base" = "$ZERO" ]; then
    base=$(git merge-base "$local_sha" origin/main 2>/dev/null) || { why="new ref with no merge-base against origin/main"; break; }
  fi
  if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then why="base ${base:0:8} is not in this clone"; break; fi
  if ! touched=$(git diff --name-only "$base" "$local_sha" -- src-tauri/ 2>/dev/null); then
    why="git diff ${base:0:8}..${local_sha:0:8} failed"
    break
  fi
  if [ -n "$touched" ]; then why="this push changes src-tauri/"; break; fi
done
[ "${#specs[@]}" -eq 0 ] && why="no pushed refs to read"

if [ -z "$why" ]; then
  say "no src-tauri/ change in this push; cargo check skipped"
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
  say "$why, but cargo is not installed. Install Rust (rustup) to push a src-tauri change."
  exit 1
fi
# tauri-build refuses to build without the sidecar named in tauri.conf.json's
# externalBin. Never create one here: an empty file would later be bundled
# by a dev build as if it were the sidecar.
triple=$(rustc -vV | awk '/^host:/{print $2}')
sidecar="src-tauri/binaries/beadbox-sidecar-${triple}"
if [ ! -e "$sidecar" ]; then
  say "$why, but $sidecar is missing (tauri-build needs it)."
  say "Build it: bun --cwd=packages/server run build:sidecar"
  exit 1
fi

say "$why: cargo check --manifest-path src-tauri/Cargo.toml"
start=$(date +%s)
cargo check --manifest-path src-tauri/Cargo.toml
rc=$?
say "cargo check exited $rc in $(($(date +%s) - start))s"
exit "$rc"
