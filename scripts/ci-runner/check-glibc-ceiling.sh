#!/usr/bin/env bash
# beadbox-73a: the .deb's GLIBC ceiling. We claim Ubuntu 24.04+, whose glibc is
# 2.39, so no ELF file in the package may need a GLIBC_x.y symbol version
# above the ceiling. Fails on a file over the ceiling, on a package holding no
# ELF file, and on ELF files that name no GLIBC version at all (an unreadable
# symbol table must not pass as "nothing needed").
#
# Usage:
#   check-glibc-ceiling.sh deb <ceiling> <file.deb>   extract, then check
#   check-glibc-ceiling.sh dir <ceiling> <dir>        check every ELF under dir
#
# OBJDUMP (default objdump) is the tool that prints the dynamic symbol table
# (`-T`); scripts/ci-runner/test-glibc-ceiling.sh points it at a stub.
set -euo pipefail

mode="${1:-}"; ceiling="${2:-}"; target="${3:-}"
if [ -z "$mode" ] || [ -z "$ceiling" ] || [ -z "$target" ]; then
  echo "usage: $0 deb|dir <ceiling> <path>" >&2
  exit 2
fi
if ! [[ "$ceiling" =~ ^[0-9]+\.[0-9]+$ ]]; then
  echo "::error::ceiling '$ceiling' is not N.N" >&2
  exit 2
fi
OBJDUMP="${OBJDUMP:-objdump}"

case "$mode" in
  deb)
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    dpkg-deb -x "$target" "$tmp"
    dir="$tmp"
    ;;
  dir) dir="$target" ;;
  *) echo "usage: $0 deb|dir <ceiling> <path>" >&2; exit 2 ;;
esac

# Is $2 a higher version than $1? (sort -V on N.N strings)
above() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$2" ]; }

bad=0
elves=0
overall=""
while IFS= read -r -d '' f; do
  magic=$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')
  [ "$magic" = "7f454c46" ] || continue
  elves=$((elves + 1))
  max=$("$OBJDUMP" -T "$f" 2>/dev/null | grep -oE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' \
    | sed 's/^GLIBC_//' | sort -uV | tail -1 || true)
  rel="${f#"$dir"/}"
  if [ -z "$max" ]; then
    echo "  $rel: no GLIBC version read"
    continue
  fi
  echo "  $rel: max GLIBC_$max"
  if [ -z "$overall" ] || above "$overall" "$max"; then overall="$max"; fi
  if above "$ceiling" "$max"; then
    echo "::error::$rel needs GLIBC_$max, above the $ceiling ceiling (Ubuntu 24.04's glibc)"
    bad=1
  fi
done < <(find "$dir" -type f -print0)

if [ "$elves" -eq 0 ]; then
  echo "::error::no ELF file found in $target"
  exit 1
fi
if [ -z "$overall" ]; then
  echo "::error::$elves ELF file(s) but no GLIBC version read from any (is $OBJDUMP working?)"
  exit 1
fi
[ "$bad" -eq 0 ] || exit 1
echo "OK: $elves ELF file(s), max GLIBC_$overall <= $ceiling"
