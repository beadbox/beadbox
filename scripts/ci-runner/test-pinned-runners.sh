#!/usr/bin/env bash
# beadbox-73a: runs check-pinned-runners.sh on the real tree (must pass), then
# on edited copies of the real workflows (decoys, each must fail), then proves
# a stand-in checker that always passes is caught.
#
# Usage: bash scripts/ci-runner/test-pinned-runners.sh  (from the repo root)
set -euo pipefail

CHECK="${CHECK:-scripts/ci-runner/check-pinned-runners.sh}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0

run() { # run <name> <want ok|red> <root>
  local name="$1" want="$2" r="$3" got
  if bash "$CHECK" "$r" > "$tmp/out" 2>&1; then got=ok; else got=red; fi
  if [ "$got" = "$want" ]; then
    echo "PASS  $name ($got)"
    [ "$got" = ok ] || sed -n 's/^::error[^:]*::/      refused: /p' "$tmp/out"
  else
    echo "FAIL  $name: want $want, got $got"; sed 's/^/      /' "$tmp/out"; fail=1
  fi
}

# decoy <name> <file> <job> <old> <new>: copy the real workflows, then in
# <file> replace the first <old> at or after the line "  <job>:" with <new>.
decoy() {
  local name="$1" file="$2" job="$3" old="$4" new="$5" r
  r="$tmp/$(printf '%s' "$name" | tr -c 'a-z0-9' '-')"
  mkdir -p "$r/.github"
  cp -R .github/workflows "$r/.github/"
  python3 -I - "$r/.github/workflows/$file" "$job" "$old" "$new" <<'PY'
import sys
p, job, old, new = sys.argv[1:]
s = open(p).read()
i = s.index("\n  " + job + ":\n")
j = s.index(old, i)
open(p, "w").write(s[:j] + new + s[j + len(old):])
PY
  run "$name" red "$r"
}

PIN='    runs-on: ubuntu-24.04'
run "the real tree" ok .
decoy "build-linux back to ubuntu-latest" release.yml build-linux "$PIN" '    runs-on: ubuntu-latest'
decoy "e2e-headless moved to ubuntu-26.04" nightly.yml e2e-headless "$PIN" '    runs-on: ubuntu-26.04'
decoy "build-frontend on ubuntu-latest, 24.04 only in a comment" release.yml build-frontend "$PIN" "    # runs-on: ubuntu-24.04
    runs-on: ubuntu-latest"
decoy "build-linux renamed" release.yml build-linux '  build-linux:' '  build-linux-x64:'
decoy "build-linux with a second runs-on" release.yml build-linux "$PIN" "$PIN
    runs-on: ubuntu-latest"
# shellcheck disable=SC2016 # a literal expression, not a shell expansion
decoy "e2e-headless on a matrix expression" nightly.yml e2e-headless "$PIN" '    runs-on: ${{ matrix.os }}'

if [ -z "${STANDIN:-}" ]; then
  printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/standin.sh"
  if CHECK="$tmp/standin.sh" STANDIN=1 bash "$0" > "$tmp/standin.out" 2>&1; then
    echo "FAIL  a stand-in checker that always passes was not caught"; fail=1
  else
    echo "PASS  a stand-in checker that always passes fails the table"
  fi
fi

[ "$fail" -eq 0 ] || { echo "pinned runners table: FAILED"; exit 1; }
echo "pinned runners table: all rows pass"
