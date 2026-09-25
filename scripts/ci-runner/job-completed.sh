#!/bin/bash
# Job-completed hook for the self-hosted macOS release runner (beadbox-5p1).
# Installed root-owned beside job-started.sh and named by
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED. Leaves nothing of a job behind for the
# next one: the job's temp dir (signing keychain, notarization key), any
# keychain the job added to the search list, and the work dir. It never fails
# the job; what it could not remove is logged.
set -uo pipefail

readonly RUNNER_HOME="/Users/beadbox-ci"
readonly RUNNER_WORK="$RUNNER_HOME/actions-runner/_work"
log() { /usr/bin/logger -t beadbox-runner-hook -- "completed: $1" 2>/dev/null || true; echo "beadbox runner hook: $1" >&2; }

# Keychain search list back to the login keychain only.
/usr/bin/security list-keychains -d user -s "$RUNNER_HOME/Library/Keychains/login.keychain-db" \
  || log "could not reset the keychain search list"

# Everything under the runner's own work dir: _temp (secrets) and the checkout.
for d in "${RUNNER_TEMP-}" "${GITHUB_WORKSPACE-}"; do
  case "$d" in
    "$RUNNER_WORK"/*)
      if [ -d "$d" ] && [ ! -L "$d" ]; then
        # BSD find -delete can exit 0 after a failed removal: check the result.
        find "$d" -mindepth 1 -delete 2>/dev/null
        [ -z "$(ls -A "$d")" ] || log "could not empty a work dir"
      fi
      ;;
    "") ;;
    *) log "skipped a path outside the runner work dir" ;;
  esac
done

left=$(find "$RUNNER_WORK" -name '*.keychain-db' -o -name '*.p8' -o -name '*.p12' 2>/dev/null | head -5)
[ -z "$left" ] || log "secret-shaped files remain under the work dir"
exit 0
