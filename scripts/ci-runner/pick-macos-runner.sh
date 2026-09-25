#!/bin/bash
# Chooses where release.yml's macOS jobs run (beadbox-5p1): the self-hosted
# release runner when it is online and idle, GitHub's macos-14 otherwise.
# GitHub has no runner fallback of its own: a job for an offline self-hosted
# label waits in the queue (up to a day), and timeout-minutes does not count
# queue time. So the choice is made here, before those jobs are queued.
#
# Writes runs_on=<JSON> to $GITHUB_OUTPUT, for runs-on: fromJSON(...).
#   MACOS_RUNNER (repo variable): "github" forces macos-14, "self-hosted"
#     forces the runner (it then waits if offline); empty means automatic.
#   GH_TOKEN: a token that may read this repo's runners (Administration:
#     read). Without it, or on any API error, the answer is macos-14.
# Never fails: every uncertain answer is the GitHub-hosted fallback.
set -uo pipefail

readonly LABEL="beadbox-macos-release"
readonly FALLBACK='"macos-14"'
readonly SELF="[\"$LABEL\"]"
: "${GITHUB_OUTPUT:?}"

pick() {
  echo "runs_on=$1" >> "$GITHUB_OUTPUT"
  echo "macOS runner: $2"
  exit 0
}

# Route to the runner only what its job-started hook admits: the same table
# (admissible.sh). Anything else (a workflow_dispatch rebuild, another branch)
# goes to GitHub, whatever the override says, instead of failing at the hook.
# shellcheck source=scripts/ci-runner/admissible.sh
source "$(dirname "${BASH_SOURCE[0]}")/admissible.sh" || pick "$FALLBACK" "macos-14 (no admissible table)"
admissible_job "${GITHUB_EVENT_NAME:-}" "${GITHUB_REF:-}" "${GITHUB_WORKFLOW_REF:-}" \
  || pick "$FALLBACK" "macos-14 (not a job $LABEL admits)"

case "${MACOS_RUNNER:-}" in
  "") ;;
  github) pick "$FALLBACK" "macos-14 (forced: MACOS_RUNNER=github)" ;;
  self-hosted) pick "$SELF" "$LABEL (forced: MACOS_RUNNER=self-hosted)" ;;
  *) pick "$FALLBACK" "macos-14 (unrecognised MACOS_RUNNER value)" ;;
esac

[ -n "${GH_TOKEN:-}" ] || pick "$FALLBACK" "macos-14 (no runner-status token)"
[ -n "${GITHUB_REPOSITORY:-}" ] || pick "$FALLBACK" "macos-14 (no repository)"

if ! idle=$(gh api "repos/$GITHUB_REPOSITORY/actions/runners" --paginate \
  --jq "[.runners[] | select(.status == \"online\" and (.busy | not) and any(.labels[]; .name == \"$LABEL\"))] | length" 2>/dev/null); then
  pick "$FALLBACK" "macos-14 (runner API unavailable)"
fi
case "$idle" in
  '' | *[!0-9]*) pick "$FALLBACK" "macos-14 (unexpected runner API answer)" ;;
  0) pick "$FALLBACK" "macos-14 ($LABEL offline or busy)" ;;
  *) pick "$SELF" "$LABEL (online and idle)" ;;
esac
