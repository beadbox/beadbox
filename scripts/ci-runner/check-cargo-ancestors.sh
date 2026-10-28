#!/bin/bash
# Self-hosted Mac only (beadbox-449.4): cargo reads .cargo/config.toml (and the
# older .cargo/config) from every directory above the one it builds in, the
# runner user's persistent HOME included. A config an earlier job left there
# would steer this signing build (a rustc wrapper, a linker, a registry).
# The checkout itself is the reviewed tree and is not checked; every ancestor
# above it must have none, as a file or a symlink.
# Usage: check-cargo-ancestors.sh <checkout dir>
set -euo pipefail
PATH=/usr/bin:/bin
d=$(dirname "${1:?checkout dir}")
while :; do
  for c in "$d/.cargo/config" "$d/.cargo/config.toml"; do
    if [ -e "$c" ] || [ -L "$c" ]; then
      echo "::error::refusing to build: $c exists above the checkout (it would configure cargo for this signing build)"
      exit 1
    fi
  done
  [ "$d" = / ] && break
  d=$(dirname "$d")
done
echo "OK: no cargo config above the checkout"
