#!/usr/bin/env bash
# Build the @beadbox/server Bun sidecar with the matching --target for the
# current (or explicitly passed) Rust triple, and place the binary in
# src-tauri/binaries/ under the filename Tauri's externalBin resolution
# expects: basename + "-" + triple, with .exe on Windows.
#
# Run this before `bun run tauri dev` or `bun run tauri build`. Both
# beforeDevCommand and beforeBuildCommand in src-tauri/tauri.conf.json
# chain into this so the binary stays fresh on every Tauri spawn.
#
# Usage:
#   copy-sidecar.sh                                     # detect host triple
#   copy-sidecar.sh aarch64-apple-darwin                # positional triple (CI)
#   copy-sidecar.sh --target x86_64-unknown-linux-gnu   # flag form (CI alt)
#
# Both positional and flag forms are accepted so release.yml's per-platform
# job invocations don't couple to one syntax (P5.1 / bb-x6lg.1).
#
# Lifted from tb0/src-tauri/scripts/copy-sidecar.sh (the working TB0.6
# reference; size-remediated NO-GO → GO via --minify + UPX). Paths
# adjusted for this repo's layout (packages/server/ is the source).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TAURI_DIR/.." && pwd)"
BINARIES_DIR="$TAURI_DIR/binaries"
SERVER_DIR="$REPO_ROOT/packages/server"
SIDECAR_BASENAME="beadbox-sidecar"

TARGET=""
FORCE_UPX="0"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    # --force-upx is a defensive escape hatch. Refused on Mach-O below
    # (ADR-2008 addendum 2: UPX-packed Mach-O fails Apple notarization).
    # Exists only so an attempt to bypass that rule fails loudly with
    # the right error message rather than silently being a no-op.
    --force-upx) FORCE_UPX="1"; shift ;;
    -h|--help)
      sed -n '1,/^set -e/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
    *)
      # Positional form: first non-flag arg is the target triple.
      if [[ -z "$TARGET" ]]; then
        TARGET="$1"
        shift
      else
        echo "Unexpected positional argument: $1 (target already set to $TARGET)" >&2
        exit 1
      fi
      ;;
  esac
done

# Map a Rust target triple to the Bun --compile target string. Tauri's
# externalBin lookup uses the Rust triple at runtime; bun build --compile
# speaks its own target names.
rust_triple_to_bun_target() {
  case "$1" in
    aarch64-apple-darwin)      echo "bun-darwin-arm64" ;;
    x86_64-apple-darwin)       echo "bun-darwin-x64" ;;
    x86_64-unknown-linux-gnu)  echo "bun-linux-x64" ;;
    aarch64-unknown-linux-gnu) echo "bun-linux-arm64" ;;
    x86_64-pc-windows-msvc)    echo "bun-windows-x64" ;;
    *) echo "Unsupported target: $1" >&2; return 1 ;;
  esac
}

# Host triple detection via rustc — same lookup Tauri does at runtime,
# so we never drift from the name Tauri resolves at externalBin time.
if [[ -z "$TARGET" ]]; then
  if ! command -v rustc >/dev/null 2>&1; then
    echo "rustc not found; install Rust or pass --target <triple>" >&2
    exit 1
  fi
  TARGET="$(rustc -vV | awk '/^host:/ {print $2}')"
fi

BUN_TARGET="$(rust_triple_to_bun_target "$TARGET")"

EXT=""
if [[ "$TARGET" == *windows* ]]; then
  EXT=".exe"
fi

OUTFILE="$BINARIES_DIR/${SIDECAR_BASENAME}-${TARGET}${EXT}"

mkdir -p "$BINARIES_DIR"

echo "[copy-sidecar] rust triple: $TARGET"
echo "[copy-sidecar] bun target:  $BUN_TARGET"
echo "[copy-sidecar] outfile:     $OUTFILE"

# --minify: small (~50 KB on a 60 MB binary) but free savings.
# --sourcemap=none: defensive; --compile already excludes sourcemaps but
#   this pins the behavior so a future Bun default change can't inflate
#   the binary silently. (Both flags are TB0.6 size-remediation findings.)
#
# bb-mhh1.6: pass the absolute path to src/index.ts instead of a
# subshell `cd $SERVER_DIR && bun build src/index.ts` form. Bun's
# resolver walks up from the entry file's parent to find package.json,
# so an absolute entry path is independent of the process CWD. On
# Windows, Git Bash's POSIX chdir does NOT change the Win32 process
# CWD that bun.exe reads via GetCurrentDirectory(); the absolute-path
# form bypasses the trap entirely. No-op on macOS/Linux. (Avoid
# `bun --cwd <path> build`: with --cwd set, bun resolves `build` as a
# package.json script — packages/server's `build` script is
# `tsc --noEmit`, not the bundler subcommand.)
bun build --compile \
  --minify \
  --sourcemap=none \
  --target="$BUN_TARGET" \
  "$SERVER_DIR/src/index.ts" \
  "$SERVER_DIR/src/lib/server-poll-worker.ts" \
  --outfile "$OUTFILE"

# macOS rejects unsigned Mach-O with "load code signature error 4" when
# launched as a sidecar. --remove-signature first because --sign errors
# with "invalid or unsupported format" on an already-signed binary. This
# is an ad-hoc signature for local dev; the notarized .app bundle provides
# the real signing identity at bundle time.
if [[ "$TARGET" == *apple-darwin* ]]; then
  codesign --remove-signature "$OUTFILE" 2>/dev/null || true
  codesign --sign - --force --deep "$OUTFILE"
fi

# Hard guard: refuse to UPX a Mach-O even with --force-upx. ADR-2008
# addendum 2 binds this — UPX-packed Mach-O binaries fail Apple
# notarization on shipping releases. The loud refusal exists so a
# future engineer doesn't bypass the rule without reading why.
if [[ "$FORCE_UPX" == "1" && "$TARGET" == *apple-darwin* ]]; then
  echo "[copy-sidecar] ERROR: --force-upx refused on $TARGET" >&2
  echo "[copy-sidecar]        UPX-packed Mach-O fails Apple notarization." >&2
  echo "[copy-sidecar]        See ADR-2008 addendum 2 (orphan 'adr' branch)." >&2
  exit 2
fi

# UPX compression on Linux ELF and Windows PE. Expected 55-70% reduction.
# NEVER run UPX on macOS Mach-O: UPX-packed Mach-O binaries fail Apple
# notarization on shipping releases (TB0.6 size-remediation AC).
# Using -9 (max compression without LZMA) keeps decompress overhead
# sub-100ms, comfortably under our 5s smoke-ping budget. --lzma would be
# smaller but can push cold start past 500ms on constrained runners.
if [[ "$TARGET" == *linux* || "$TARGET" == *windows* ]]; then
  if command -v upx >/dev/null 2>&1; then
    before=$(wc -c < "$OUTFILE" | tr -d ' ')
    upx -9 --quiet "$OUTFILE"
    after=$(wc -c < "$OUTFILE" | tr -d ' ')
    reduction=$(awk -v b="$before" -v a="$after" 'BEGIN{printf "%.1f", (b-a)*100/b}')
    echo "[copy-sidecar] UPX: ${before} → ${after} bytes (${reduction}% reduction)"
  else
    echo "[copy-sidecar] WARN: upx not on PATH; skipping compression for $TARGET" >&2
    echo "[copy-sidecar]       install: apt install upx-ucl (Linux) / choco install upx (Windows)" >&2
  fi
fi

ls -lh "$OUTFILE"
