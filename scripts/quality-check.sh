#!/usr/bin/env bash
# bb-ystl.2 (QD.2): local quality-check wrapper for engineers iterating
# before pushing: lint + per-package typecheck. Coverage + mutation are
# NOT in this script — they're slow and best run as CI artifacts on a PR.
# (The CCN complexity check that used to run here was deleted with its CI
# gate, beadbox-clu.)
#
# Usage: bun run quality:check  (or: bash scripts/quality-check.sh)

set -e

echo "=== bun run lint ==="
bun run lint

echo "=== typecheck packages/server ==="
bun --cwd=packages/server run typecheck

echo "=== typecheck packages/client ==="
bun --cwd=packages/client run typecheck

echo "✓ quality:check passed"
