#!/usr/bin/env bash
# The two test tiers on main (beadbox-mol-dph, systemdesign §7.1).
#
#   scripts/ci-tests.sh fast|full                  run every shard of the tier
#   scripts/ci-tests.sh fast|full --list           print "<shard>\t<package>\t<file>"
#   scripts/ci-tests.sh fast|full --shard <name>   run one shard (one CI job)
#
# fast: every test file bun would discover in packages/server and
# packages/client, minus the files in scripts/slow-tests.txt; every
# *.security.test.ts always runs. full: every file. Shards are built with
# the round-robin loop of scripts/prepush-tests.sh: server-0..N and
# client-0..M, plus server-security for the security tests.
#
# Every run prints the 20 slowest files by wall time (and writes them to
# $GITHUB_STEP_SUMMARY on CI): the drift control for the list.
#
# Files are passed as ./-prefixed paths: bare arguments are substring
# filters to bun test and could pick up a neighbouring file.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

SERVER_SHARDS=${BEADBOX_CI_SERVER_SHARDS:-4}
CLIENT_SHARDS=${BEADBOX_CI_CLIENT_SHARDS:-2}
SLOW_LIST=${BEADBOX_CI_SLOW_LIST:-scripts/slow-tests.txt}

usage() {
  echo "usage: scripts/ci-tests.sh fast|full [--list | --shard <name>]" >&2
  exit 2
}

tier=${1:-}
case "$tier" in fast | full) ;; *) usage ;; esac
action=run
only=""
case "${2:-}" in
  "") ;;
  --list) action=list ;;
  --shard)
    [ -n "${3:-}" ] || usage
    only=$3
    ;;
  *) usage ;;
esac

# --- the slow list -----------------------------------------------------------
slow=()
while read -r path _; do
  case "$path" in "" | \#*) continue ;; esac
  if [ ! -f "$path" ]; then
    echo "[ci-tests] $SLOW_LIST lists $path, which does not exist" >&2
    exit 1
  fi
  case "$path" in
    *.security.test.ts | *.security.test.tsx)
      echo "[ci-tests] $SLOW_LIST lists $path; security tests always run on push" >&2
      exit 1
      ;;
  esac
  slow+=("$path")
done <"$SLOW_LIST"

is_slow() {
  local s
  for s in "${slow[@]+"${slow[@]}"}"; do [ "$s" = "$1" ] && return 0; done
  return 1
}

# Every file bun test discovers in a package, relative to the package, sorted.
# Same pattern as discoverTestFiles() in slow-test-census.test.ts.
discover() { # package dir
  (cd "$1" && find . -path ./node_modules -prune -o -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.jsx' \
    -o -name '*_test.ts' -o -name '*_test.tsx' -o -name '*_test.js' -o -name '*_test.jsx' \
    -o -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.spec.js' -o -name '*.spec.jsx' \) \
    -print | LC_ALL=C sort)
}

# --- shard lists -------------------------------------------------------------
# Parallel arrays: shard name, package dir, ./file.
s_name=()
s_pkg=()
s_file=()
add() { s_name+=("$1"); s_pkg+=("$2"); s_file+=("$3"); }

shard_package() { # prefix, package dir, shard count, security-separately (true|false)
  local prefix=$1 pkg=$2 n=$3 split_security=$4 f i j
  local files=() security=()
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *.security.test.ts | *.security.test.tsx)
        if $split_security; then security+=("$f") && continue; fi
        ;;
      *) [ "$tier" = "fast" ] && is_slow "$pkg/${f#./}" && continue ;;
    esac
    files+=("$f")
  done < <(discover "$pkg")
  for ((i = 0; i < n; i++)); do
    for ((j = i; j < ${#files[@]}; j += n)); do add "$prefix-$i" "$pkg" "${files[$j]}"; done
  done
  for f in "${security[@]+"${security[@]}"}"; do add "$prefix-security" "$pkg" "$f"; done
}

shard_package server packages/server "$SERVER_SHARDS" true
shard_package client packages/client "$CLIENT_SHARDS" false

if [ "$action" = "list" ]; then
  for ((i = 0; i < ${#s_name[@]}; i++)); do
    printf '%s\t%s\t%s\n' "${s_name[$i]}" "${s_pkg[$i]}" "${s_file[$i]}"
  done
  exit 0
fi

# --- run ---------------------------------------------------------------------
names=()
for n in "${s_name[@]}"; do
  case " ${names[*]+"${names[*]}"} " in *" $n "*) ;; *) names+=("$n") ;; esac
done
if [ -n "$only" ]; then
  case " ${names[*]} " in *" $only "*) ;; *)
    echo "[ci-tests] no shard named $only in the $tier tier (have: ${names[*]})" >&2
    exit 2
    ;;
  esac
  names=("$only")
fi

LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/beadbox-ci-tests.XXXXXX")
pids=()
pkgs=()
for n in "${names[@]}"; do
  args=()
  pkg=""
  for ((i = 0; i < ${#s_name[@]}; i++)); do
    [ "${s_name[$i]}" = "$n" ] || continue
    pkg=${s_pkg[$i]}
    args+=("${s_file[$i]}")
  done
  # Every line timestamped, for the per-file wall times below.
  (cd "$pkg" && set -o pipefail && bun test --timeout=30000 "${args[@]}" 2>&1 |
    perl -MTime::HiRes=time -ne '$| = 1; printf "%.3f %s", time, $_') >"$LOGDIR/$n.log" 2>&1 &
  pids+=($!)
  pkgs+=("$pkg")
done

untimestamp() { sed -E 's/^[0-9]+\.[0-9]+ //' "$@"; }

failed=()
for ((i = 0; i < ${#names[@]}; i++)); do
  if ! wait "${pids[$i]}"; then failed+=("${names[$i]}"); fi
done
for n in "${names[@]}"; do
  summary=$(untimestamp "$LOGDIR/$n.log" | grep -E '^Ran [0-9]+ tests' | tail -1)
  echo "[ci-tests] $tier $n: ${summary:-no summary}"
done

# The slowest files by wall time: drift control for the list, since time has
# no scannable sign. A shard runs its files one after another, and under
# GitHub Actions bun prints the workflow command "::group::<file>:" as each
# one starts (GitHub's log shows it as "##[group]"), so a file's time is the
# gap to the next header (or to the shard's "Ran" line).
times="$LOGDIR/times.tsv"
: >"$times"
for ((i = 0; i < ${#names[@]}; i++)); do
  awk -v pfx="${pkgs[$i]}/" '
    { ts = $1; sub(/^[^ ]+ /, "") }
    /^(::group::|##\[group\]).*\.(test|spec)\.(ts|tsx|js|jsx):$/ {
      if (cur != "") printf "%.1f\t%s%s\n", ts - start, pfx, cur
      cur = $0; sub(/^(::group::|##\[group\])/, "", cur); sub(/:$/, "", cur); start = ts; next
    }
    /^Ran [0-9]+ tests/ { if (cur != "") printf "%.1f\t%s%s\n", ts - start, pfx, cur; cur = "" }
  ' "$LOGDIR/${names[$i]}.log" >>"$times"
done
if [ -s "$times" ]; then
  echo "[ci-tests] $tier: the 20 slowest test files (wall s; a # fast: file over 5 s moves to scripts/slow-tests.txt):"
  sort -rn "$times" | head -20 | awk -F'\t' '{ printf "[ci-tests]   %6.1f  %s\n", $1, $2 }'
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### $tier tier: the 20 slowest test files"
      echo ""
      echo "| seconds | file |"
      echo "|---:|---|"
      sort -rn "$times" | head -20 | awk -F'\t' '{ printf "| %.1f | `%s` |\n", $1, $2 }'
    } >>"$GITHUB_STEP_SUMMARY"
  fi
else
  echo "[ci-tests] per-file times need bun's ::group:: lines, which it prints under GitHub Actions"
fi

if [ ${#failed[@]} -gt 0 ]; then
  for n in "${failed[@]}"; do
    echo "[ci-tests] ---- $n FAILED ----"
    untimestamp "$LOGDIR/$n.log" | grep -E '^\(fail\)|error:|Expected|Received' | head -40
    echo "[ci-tests] full log: $LOGDIR/$n.log"
  done
  exit 1
fi
rm -rf "$LOGDIR"
exit 0
