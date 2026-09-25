#!/bin/bash
# Job-started hook for the self-hosted macOS release runner (beadbox-5p1).
#
# On GitHub's Free plan any workflow in this public repository, including one
# added by a pull request, can name the runner's label. This hook is the
# control that keeps such jobs off the machine: the runner executes it before
# the first workflow step, and a nonzero exit fails the job there.
#
# It must be installed ROOT-OWNED outside anything the runner user can write,
# and named by ACTIONS_RUNNER_HOOK_JOB_STARTED in the runner's root-owned .env
# (see the registration steps on the bead). A copy a job could edit would be no
# control at all.
#
# Allowlist only, exact comparisons, fail closed: any unset value, any
# disagreement, or any error refuses. The only `exit 0` is the last line.
set -euo pipefail

readonly REPO="beadbox/beadbox"
# Workflows allowed on this runner, as they appear in GITHUB_WORKFLOW_REF.
readonly WORKFLOWS=".github/workflows/release.yml"
readonly TAG_RE='^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$'
readonly SHA_RE='^[0-9a-f]{40}$'
# The runner user's home, fixed at install time (not taken from the job's env).
readonly RUNNER_HOME="/Users/beadbox-ci"
readonly RUNNER_WORK="$RUNNER_HOME/actions-runner/_work"
readonly JQ=/usr/bin/jq

# Values below can be attacker-chosen (a ref name); keep them inert in logs.
clean() { printf '%s' "${1-<unset>}" | LC_ALL=C tr -cd 'A-Za-z0-9/._@+-' | cut -c1-200; }

refuse() {
  trap - ERR
  local msg
  msg="refused: $1 (repo=$(clean "${GITHUB_REPOSITORY-}") event=$(clean "${GITHUB_EVENT_NAME-}") ref=$(clean "${GITHUB_REF-}") workflow_ref=$(clean "${GITHUB_WORKFLOW_REF-}"))"
  /usr/bin/logger -t beadbox-runner-hook -- "$msg" 2>/dev/null || true
  echo "beadbox runner hook $msg" >&2
  exit 1
}
trap 'refuse "hook error at line $LINENO"' ERR

for v in GITHUB_REPOSITORY GITHUB_EVENT_NAME GITHUB_REF GITHUB_WORKFLOW_REF \
  GITHUB_WORKFLOW_SHA GITHUB_SHA GITHUB_EVENT_PATH GITHUB_WORKSPACE; do
  [ -n "${!v-}" ] || refuse "$v is unset or empty"
done

# H1-H3: this repository, a push, to main or a release tag.
[ "$GITHUB_REPOSITORY" = "$REPO" ] || refuse "repository"
[ "$GITHUB_EVENT_NAME" = "push" ] || refuse "event"
if [ "$GITHUB_REF" != "refs/heads/main" ] && ! [[ "$GITHUB_REF" =~ $TAG_RE ]]; then
  refuse "ref"
fi

# H4: an allowed workflow file, from that same ref.
allowed=no
for w in $WORKFLOWS; do
  if [ "$GITHUB_WORKFLOW_REF" = "$REPO/$w@$GITHUB_REF" ]; then allowed=yes; fi
done
[ "$allowed" = "yes" ] || refuse "workflow_ref"

# H5: the workflow file comes from the pushed commit.
[[ "$GITHUB_SHA" =~ $SHA_RE ]] || refuse "sha"
[ "$GITHUB_WORKFLOW_SHA" = "$GITHUB_SHA" ] || refuse "workflow_sha"

# H6: no pull-request values at all.
[ -z "${GITHUB_HEAD_REF-}" ] || refuse "head_ref present"
[ -z "${GITHUB_BASE_REF-}" ] || refuse "base_ref present"

# H7: the event payload the runner wrote must agree. It must be the runner's
# own file (inside its work dir), not a path the job's environment names.
case "$GITHUB_EVENT_PATH" in
  "$RUNNER_WORK"/*) ;;
  *) refuse "event payload outside the runner work dir" ;;
esac
[ -x "$JQ" ] || refuse "jq missing"
[ -f "$GITHUB_EVENT_PATH" ] && [ ! -L "$GITHUB_EVENT_PATH" ] || refuse "event payload unreadable"
# shellcheck disable=SC2016 # $repo and $ref are jq variables
"$JQ" -e --arg repo "$REPO" --arg ref "$GITHUB_REF" \
  '(.repository.full_name == $repo) and (.ref == $ref) and (has("pull_request") | not)' \
  "$GITHUB_EVENT_PATH" >/dev/null || refuse "event payload disagrees"

# Admitted. Start from an empty work dir (the runner's own, and nothing else).
case "$GITHUB_WORKSPACE" in
  "$RUNNER_WORK"/*) ;;
  *) refuse "workspace outside the runner work dir" ;;
esac
if [ -d "$GITHUB_WORKSPACE" ] && [ ! -L "$GITHUB_WORKSPACE" ]; then
  find "$GITHUB_WORKSPACE" -mindepth 1 -delete
  # BSD find -delete reports a failed removal but still exits 0: check the
  # result. A plain assignment, so an ls that fails (an unreadable dir) trips
  # set -e and the ERR trap instead of reading as "empty".
  left=$(ls -A "$GITHUB_WORKSPACE")
  [ -z "$left" ] || refuse "work dir could not be emptied"
fi
/usr/bin/logger -t beadbox-runner-hook -- "admitted: ref=$(clean "$GITHUB_REF") sha=$(clean "$GITHUB_SHA")" 2>/dev/null || true
exit 0
