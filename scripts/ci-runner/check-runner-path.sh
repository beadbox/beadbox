#!/bin/bash
# Release runner only (beadbox-5p1): refuse the job unless every program it can
# run comes from somewhere no other account on the machine can change. Every
# PATH entry outside the job's own dirs, and the whole Rust toolchain, must be
# owned by root with no group or other write bit, ancestors included.
# Usage: check-runner-path.sh <PATH to check> <rust toolchain dir>
set -euo pipefail
path=$1
tools=$2
# Its own commands come from the system dirs, never from the PATH it checks.
PATH=/usr/bin:/bin
# shellcheck source=scripts/ci-runner/trusted-path.sh
source "${BASH_SOURCE[0]%/*}/trusted-path.sh"
why=$(untrusted_path_entries "$path" "${HOME:?}" "${RUNNER_TEMP:?}" -- root)
if [ -n "$why" ]; then echo "::error::untrusted $why"; exit 1; fi
why=$(untrusted_tree "$tools" root)
if [ -n "$why" ]; then echo "::error::untrusted Rust toolchain: $why"; exit 1; fi
echo "OK: every PATH entry and the Rust toolchain are root-owned and not writable by other accounts"
