#!/bin/bash
# Self-hosted Mac only (beadbox-5p1, beadbox-449.4): refuse the job unless every
# program it can run comes from somewhere no OTHER account on the machine can
# change. Every PATH entry outside the job's own dirs must be owned by root,
# and the Rust toolchain (installed per job under $RUNNER_TEMP) by root or the
# runner user itself; no group or other write bit, ancestors included. A dir
# another account owns (another user's Homebrew, say) is refused.
# Usage: check-runner-path.sh <PATH to check> <rust toolchain dir>
set -euo pipefail
path=$1
tools=$2
# Its own commands come from the system dirs, never from the PATH it checks.
PATH=/usr/bin:/bin
# shellcheck source=scripts/ci-runner/trusted-path.sh
source "${BASH_SOURCE[0]%/*}/trusted-path.sh"
# Only this job's own temp dir is skipped. On the long-lived Mac runner the
# runner user's HOME persists between jobs, so a PATH entry there could hold
# what an earlier job left behind: it must be root-owned like any other.
why=$(untrusted_path_entries "$path" "${RUNNER_TEMP:?}" -- root)
if [ -n "$why" ]; then echo "::error::untrusted $why"; exit 1; fi
why=$(untrusted_tree "$tools" root "$(id -un)")
if [ -n "$why" ]; then echo "::error::untrusted Rust toolchain: $why"; exit 1; fi
echo "OK: no other account can change any PATH entry or the Rust toolchain"
