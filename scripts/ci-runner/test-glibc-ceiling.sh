#!/usr/bin/env bash
# beadbox-73a: table test of check-glibc-ceiling.sh, against a stub objdump.
# Each fake ELF file holds the magic bytes and the symbol versions the stub
# prints for it. The live red (the real .deb against a ceiling of 2.0) runs in
# release.yml's build-linux, where objdump and dpkg-deb exist.
#
# Usage: bash scripts/ci-runner/test-glibc-ceiling.sh  (from the repo root)
set -euo pipefail

CHECK="${CHECK:-scripts/ci-runner/check-glibc-ceiling.sh}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The stub prints the file's lines after the magic as a dynamic symbol table.
cat > "$tmp/objdump" <<'EOF'
#!/usr/bin/env bash
tail -n +2 "$2"
EOF
chmod +x "$tmp/objdump"

elf() { # elf <dir> <name> <versions...>
  local d="$1" f="$2"
  shift 2
  { printf '\177ELF\n'
    for v in "$@"; do
      printf '0000000000000000      DF *UND*  0000000000000000 (GLIBC_%s) memcpy\n' "$v"
    done; } > "$d/$f"
}

fail=0
row() { # row <name> <want ok|red> <dir>
  local name="$1" want="$2" d="$3" got
  if OBJDUMP="$tmp/objdump" bash "$CHECK" dir 2.39 "$d" > "$tmp/out" 2>&1; then got=ok; else got=red; fi
  if [ "$got" = "$want" ]; then
    echo "PASS  $name ($got)"
  else
    echo "FAIL  $name: want $want, got $got"; sed 's/^/      /' "$tmp/out"; fail=1
  fi
}

n=0
mk() { n=$((n + 1)); dir="$tmp/case$n"; mkdir -p "$dir"; }

mk; elf "$dir" beadbox 2.2.5 2.34 2.39
elf "$dir" sidecar 2.17 2.28
row "every file at or under 2.39" ok "$dir"

mk; elf "$dir" beadbox 2.34 2.41
elf "$dir" sidecar 2.17
row "one file needs 2.41 (built on a newer image)" red "$dir"

mk; elf "$dir" beadbox 2.39.1
row "a three-part 2.39.1 is above 2.39" red "$dir"

mk; elf "$dir" beadbox 2.4
row "2.4 compares as a version, below 2.39" ok "$dir"

mk; printf 'not an elf\n(GLIBC_2.99)\n' > "$dir/readme"
row "no ELF file in the package" red "$dir"

mk; elf "$dir" beadbox
row "ELF files but no GLIBC version read" red "$dir"

mk; elf "$dir" beadbox 2.34
printf 'text\n(GLIBC_2.99)\n' > "$dir/notes.txt"
row "a non-ELF file naming GLIBC_2.99 is ignored" ok "$dir"

# A checker that always passes must fail this table.
if [ -z "${STANDIN:-}" ]; then
  printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/standin.sh"
  if CHECK="$tmp/standin.sh" STANDIN=1 bash "$0" > "$tmp/standin.out" 2>&1; then
    echo "FAIL  a stand-in checker that always passes was not caught"; fail=1
  else
    echo "PASS  a stand-in checker that always passes fails the table"
  fi
fi

[ "$fail" -eq 0 ] || { echo "glibc ceiling table: FAILED"; exit 1; }
echo "glibc ceiling table: all rows pass"
