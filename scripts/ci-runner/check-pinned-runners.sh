#!/usr/bin/env bash
# beadbox-73a: jobs whose verdict depends on the OS image are pinned to a named
# Ubuntu, never ubuntu-latest, so an image move is a choice we make. Each job
# in PINNED must hold exactly one job-level `runs-on: ubuntu-24.04`. A pinned
# job that is renamed or removed fails too: update this list with it.
#
# Every other job floats on purpose (beadbox-73a's PLAN lists each, and why).
#
# Usage: check-pinned-runners.sh [<repo root>]   (default: .)
set -euo pipefail

root="${1:-.}"
WANT='ubuntu-24.04'
PINNED='
release.yml build-frontend
release.yml build-linux
nightly.yml e2e-headless
'

bad=0
n=0
while read -r file job; do
  [ -n "$file" ] || continue
  n=$((n + 1))
  path="$root/.github/workflows/$file"
  if [ ! -f "$path" ]; then
    echo "::error::$file: no such workflow (pinned job $job)"
    bad=1
    continue
  fi
  # The job's block: from "  <job>:" to the next job id or the file end.
  block=$(awk -v want="$job" '
    /^jobs:/ { injobs = 1; next }
    injobs && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { id = $1; sub(":", "", id); on = (id == want) }
    injobs && on { print }
  ' "$path")
  if [ -z "$block" ]; then
    echo "::error file=.github/workflows/$file::pinned job $job not found (renamed or removed? update PINNED in $0)"
    bad=1
    continue
  fi
  runs=$(printf '%s\n' "$block" | grep -E '^    runs-on:' || true)
  count=$(printf '%s' "$runs" | grep -c . || true)
  val=$(printf '%s\n' "$runs" | head -1 | sed -E 's/^    runs-on:[[:space:]]*//; s/[[:space:]]+(#.*)?$//')
  if [ "$count" -ne 1 ]; then
    echo "::error file=.github/workflows/$file::$job has $count job-level runs-on lines, want exactly one: runs-on: $WANT"
    bad=1
  elif [ "$val" != "$WANT" ]; then
    echo "::error file=.github/workflows/$file::$job runs on '$val'; it is pinned to $WANT (beadbox-73a: moving it is a decision, made here and in this list)"
    bad=1
  else
    echo "  $file $job: $WANT"
  fi
done <<< "$PINNED"

[ "$bad" -eq 0 ] || exit 1
echo "OK: all $n pinned jobs run on $WANT"
