#!/bin/bash
# Reds and controls for what the self-hosted Mac's signing job may execute
# (beadbox-5p1 trust checks, kept by beadbox-449.4 when the root-hook design
# was retired): trusted-path.sh, check-runner-path.sh, and the parts of
# release.yml that keep each macOS build's toolchain and caches per job.
# Runs without root: the owner set is a parameter, here {root, this user}.
# Usage: scripts/ci-runner/test-runner-path.sh
set -uo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$DIR/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
# A PATH of root-owned, non-symlinked system dirs (on merged-/usr Linux /bin is
# a symlink, which the checks rightly refuse).
if [ -L /bin ]; then SYS_PATH=/usr/bin; else SYS_PATH=/usr/bin:/bin; fi

# ---------------------------------------------------------------------------
# trusted-path.sh: what the signing job may execute. The owner set is a
# parameter so these run without root: here it is {root, this user}, over a
# tree under $HOME (whose ancestors are root- or user-owned, not shared).
# shellcheck source=scripts/ci-runner/trusted-path.sh
source "$DIR/trusted-path.sh"
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
# The planted dir is under $HOME, which persists between jobs on the
# long-lived runner (beadbox-449.4): it must be refused, and for the PATH
# reason, not the toolchain (TC is owned by this user, a trusted owner here).
if env -i HOME="$HOME" RUNNER_TEMP="$T" PATH="$B/planted:$SYS_PATH" /bin/bash "$DIR/check-runner-path.sh" "$B/planted:$SYS_PATH" "$TC" >"$T/crp.out" 2>&1; then
  tfail=$((tfail + 1)); echo "FAIL trust [check-runner-path refuses planted PATH]: it passed"
elif [ -e "$B/CHECK_PLANTED_RAN" ]; then
  tfail=$((tfail + 1)); echo "FAIL trust [check-runner-path ran a planted tool]"
elif ! grep -q "::error::untrusted PATH" "$T/crp.out" || grep -q "Rust toolchain" "$T/crp.out"; then
  tfail=$((tfail + 1)); echo "FAIL trust [check-runner-path refuses planted PATH]: refused for another reason: $(cat "$T/crp.out")"
else
  tpass=$((tpass + 1))
fi
# Control: the same check passes a PATH whose only non-system entry is under
# this job's own RUNNER_TEMP (skipped), with the same toolchain.
mkdir -p "$T/own/bin" && chmod 755 "$T/own" "$T/own/bin"
if env -i HOME="$HOME" RUNNER_TEMP="$T" PATH="$SYS_PATH" /bin/bash "$DIR/check-runner-path.sh" "$T/own/bin:$SYS_PATH" "$TC" >"$T/crp2.out" 2>&1; then
  tpass=$((tpass + 1))
else
  tfail=$((tfail + 1)); echo "FAIL trust [check-runner-path passes a RUNNER_TEMP PATH entry]: $(cat "$T/crp2.out")"
fi
chmod -R u+w "$B" && rm -rf "$B"
echo "trust tests: $tpass passed, $tfail failed"

# ---------------------------------------------------------------------------
# release.yml (beadbox-449.4): on the self-hosted Mac, Rust and the package
# caches are this job's own, under $RUNNER_TEMP, from a pinned and checksummed
# rustup-init; the PATH/toolchain check runs; GitHub's toolchain and cache
# actions stay limited to hosted runners.
rpass=0; rfail=0
REL="$REPO_ROOT/.github/workflows/release.yml"
# shellcheck disable=SC2016 # the greps in this block look for literal workflow text
if [ -f "$REL" ]; then
  r=ok
  grep -qE 'beadbox-runner-cache|CARGO_TARGET_DIR|/usr/local/libexec/beadbox-runner' "$REL" && r="names a persistent or root-installed build dir"
  grep -q 'export RUSTUP_HOME="$RUNNER_TEMP/rustup" CARGO_HOME="$RUNNER_TEMP/cargo-home"' "$REL" || r="Rust is not per job under RUNNER_TEMP"
  grep -q 'echo "BUN_INSTALL_CACHE_DIR=$RUNNER_TEMP/bun-cache"' "$REL" || r="no per-job bun cache"
  grep -qE 'RUSTUP_INIT_SHA256: "[0-9a-f]{64}"' "$REL" || r="rustup-init not pinned to a sha256"
  grep -q 'echo "$RUSTUP_INIT_SHA256  $RUNNER_TEMP/rustup-init" | shasum -a 256 -c -' "$REL" || r="rustup-init checksum not verified"
  grep -qE 'RUST_VERSION: "[0-9]+\.[0-9]+\.[0-9]+"' "$REL" || r="Rust version not pinned"
  grep -q 'bash scripts/ci-runner/check-runner-path.sh "$CARGO_HOME/bin:$PATH" "$RUSTUP_HOME"' "$REL" || r="no PATH/toolchain trust check"
  [ "$(grep -A1 -E 'name: (Rust cache|Setup Rust)$' "$REL" | grep -c "if: runner.environment == 'github-hosted'")" -ge 2 ] || r="GitHub cache/toolchain not limited to hosted runners"
  if [ "$r" = ok ]; then rpass=$((rpass + 1)); else rfail=$((rfail + 1)); echo "FAIL release.yml: $r"; fi
else
  rfail=$((rfail + 1)); echo "FAIL: release.yml not found at $REL"
fi
echo "release.yml tests: $rpass passed, $rfail failed"
[ "$tfail" -eq 0 ] && [ "$rfail" -eq 0 ]
