# shellcheck shell=bash
# The jobs the self-hosted macOS release runner may run (beadbox-5p1). This is
# the ONE table both sides read: job-started.sh, the control on the runner
# (sourcing its root-owned copy installed beside it), and pick-macos-runner.sh,
# which only routes a job to the runner when the runner would admit it.
#
# A job is admissible when ONE row matches it exactly: the event is that exact
# string, the ref matches that row's anchored pattern, and the workflow ref is
# exactly <repo>/<workflow file>@<that same ref>. A workflow that another one
# calls reports its CALLER in GITHUB_WORKFLOW_REF, which is why a main build
# (build-main.yml calling release.yml) is listed under build-main.yml.
#
# Sourced, never executed. Patterns must not contain '|'.

ADMISSIBLE_REPO="beadbox/beadbox"

# event | anchored ref pattern | workflow file
ADMISSIBLE_JOBS=(
  'push|^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$|.github/workflows/release.yml'
  'push|^refs/heads/main$|.github/workflows/build-main.yml'
)

# admissible_event <event>: some row allows this event at all.
admissible_event() {
  local row ev re wf
  for row in "${ADMISSIBLE_JOBS[@]}"; do
    IFS='|' read -r ev re wf <<< "$row"
    if [ "$1" = "$ev" ]; then return 0; fi
  done
  return 1
}

# admissible_job <event> <ref> <workflow_ref>: one row matches all three.
admissible_job() {
  local row ev re wf
  for row in "${ADMISSIBLE_JOBS[@]}"; do
    IFS='|' read -r ev re wf <<< "$row"
    if [ "$1" = "$ev" ] && [[ "$2" =~ $re ]] && [ "$3" = "$ADMISSIBLE_REPO/$wf@$2" ]; then
      return 0
    fi
  done
  return 1
}
