#!/bin/bash
# Supervisor for the self-hosted macOS release runner (beadbox-5p1). Runs as
# ROOT from a LaunchDaemon; runs each job as the unprivileged runner user.
#
# Every cycle serves exactly ONE job (an ephemeral, just-in-time runner):
#   0. end EVERY process of the runner user and verify none is left. A process
#      a job leaves behind (setsid, nohup, a launchd agent) would otherwise
#      run, as the same user, next to the next job's signing keys. Then reset
#      the runner user's home to an allowlist, so no file a job wrote there
#      (a ~/.cargo/config.toml that cargo reads from every ancestor of the
#      build dir, a package cache, a shell rc file, a LaunchAgent) reaches a
#      later build. If either fails, no runner starts and builds take the
#      GitHub fallback;
#   1. rebuild the runner dir from a root-owned pristine copy of the pinned
#      runner release, so nothing a previous job wrote there (an edited .env,
#      a self-updated runner, stray files) survives into the next job;
#   2. write the hook settings into that fresh .env, root-owned;
#   3. ask GitHub for a single-use JIT runner config (the token that can do
#      that is readable by root only);
#   4. run that one job as the runner user, then start over.
# The job-started hook (job-started.sh) decides whether the job may run at all.
set -euo pipefail

readonly REPO="beadbox/beadbox"
readonly RUNNER_USER="beadbox-ci"
readonly RUNNER_NAME="beadbox-macos-release"
readonly LABEL="beadbox-macos-release"
readonly RUNNER_HOME="/Users/$RUNNER_USER"
readonly RUNNER_DIR="$RUNNER_HOME/actions-runner"
readonly LIBEXEC="/usr/local/libexec/beadbox-runner"   # root:wheel 0755
readonly TEMPLATE="$LIBEXEC/runner-template"          # pinned runner release, root-owned
# The job's PATH holds only root-owned dirs: $LIBEXEC/bin (gh, pinned) and the
# system's. Homebrew and /usr/local/bin are writable by other accounts here.
# root 0600, one line: "Authorization: Bearer <token>" (Administration
# read/write on $REPO only). Read by curl as a header file, never put on a
# command line: macOS shows every user's process arguments.
readonly TOKEN_HEADER="/var/root/beadbox-runner-auth-header"
readonly LOG_TAG="beadbox-runner-cycle"

log() { /usr/bin/logger -t "$LOG_TAG" -- "$1"; }

# The runner user's processes, and ending them. The uid is dedicated to this
# runner, so matching on it is scoped by construction (no command-line
# patterns). test-hooks.sh replaces these two with its own scoped versions.
runner_procs() { /usr/bin/pgrep -u "$RUNNER_USER"; }
kill_runner_procs() {
  /bin/launchctl bootout "user/$(/usr/bin/id -u "$RUNNER_USER")" >/dev/null 2>&1 || true
  /usr/bin/pkill -KILL -u "$RUNNER_USER" || true
}

# Step 0. Succeeds only when no process of the runner user is left.
clear_runner_user() {
  kill_runner_procs
  for _ in $(seq 1 20); do
    if ! runner_procs >/dev/null; then return 0; fi
    sleep 0.5
  done
  log "processes of $RUNNER_USER survived the kill: $(runner_procs | tr '\n' ' '); not starting a runner"
  return 1
}

# Step 0, second half: the runner user's home keeps ONLY Library/Keychains.
# Build state and config a job could plant (for later, signing builds) lives
# anywhere else in there. Succeeds only when nothing else is left.
reset_runner_home() {
  local home=$1 left
  [ -d "$home" ] && [ ! -L "$home" ] || { log "runner home missing: $home"; return 1; }
  find "$home" -mindepth 1 -maxdepth 1 ! -name Library -exec rm -rf {} + 2>/dev/null
  if [ -d "$home/Library" ] && [ ! -L "$home/Library" ]; then
    find "$home/Library" -mindepth 1 -maxdepth 1 ! -name Keychains -exec rm -rf {} + 2>/dev/null
  else
    rm -rf "$home/Library"
  fi
  # BSD find/rm can report success after a failed removal: check the result.
  left=$(find "$home" -mindepth 1 ! -path "$home/Library" ! -path "$home/Library/Keychains" ! -path "$home/Library/Keychains/*")
  if [ -n "$left" ]; then
    log "could not reset $home: $(printf '%s' "$left" | head -3 | tr '\n' ' '); not starting a runner"
    return 1
  fi
}

main() {
  [ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
  [ -d "$TEMPLATE" ] || { log "no runner template at $TEMPLATE"; exit 1; }
  [ -f "$TOKEN_HEADER" ] || { log "no token header file"; exit 1; }

  local body jit handoff rc
  while :; do
    # 0. Nothing of the previous job may still be running. Fail closed: keep
    #    retrying, and never start a runner while anything survives.
    until clear_runner_user && reset_runner_home "$RUNNER_HOME"; do sleep 60; done

    # 1. A fresh runner dir from the pristine template.
    rm -rf "$RUNNER_DIR"
    /usr/bin/ditto "$TEMPLATE" "$RUNNER_DIR"
    chown -R "$RUNNER_USER:staff" "$RUNNER_DIR"
    chmod 700 "$RUNNER_DIR"

    # 2. Hook settings, root-owned. The dir is rebuilt next cycle whatever a job does.
    printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\nACTIONS_RUNNER_HOOK_JOB_COMPLETED=%s\n' \
      "$LIBEXEC/job-started.sh" "$LIBEXEC/job-completed.sh" > "$RUNNER_DIR/.env"
    chown root:wheel "$RUNNER_DIR/.env"
    chmod 644 "$RUNNER_DIR/.env"

    # 3. A single-use JIT config. It would let its holder receive the job and
    #    its secrets, so it never appears in any process's arguments.
    body=$(printf '{"name":"%s","runner_group_id":1,"labels":["%s"],"work_folder":"_work"}' "$RUNNER_NAME" "$LABEL")
    if ! jit=$(/usr/bin/curl -fsS -X POST \
        -H @"$TOKEN_HEADER" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/repos/$REPO/actions/runners/generate-jitconfig" \
        -d "$body" | /usr/bin/jq -er '.encoded_jit_config'); then
      log "could not get a JIT config; retrying in 60s"
      sleep 60
      continue
    fi

    # Hand it over in a file only the runner user can read; the job wrapper
    # moves it into the environment (not visible to other users) and deletes it.
    handoff="$RUNNER_DIR/.jitconfig"
    (umask 077 && printf '%s' "$jit" > "$handoff")
    unset jit
    chown "$RUNNER_USER:staff" "$handoff"
    chmod 400 "$handoff"

    # 4. One job, as the runner user, with a minimal environment.
    log "runner up for one job"
    set +e
    /usr/bin/sudo -u "$RUNNER_USER" -H /usr/bin/env -i \
      HOME="$RUNNER_HOME" USER="$RUNNER_USER" LOGNAME="$RUNNER_USER" \
      PATH="$LIBEXEC/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      LANG=en_US.UTF-8 \
      /bin/bash -c 'cd "$1" || exit 1
        ACTIONS_RUNNER_INPUT_JITCONFIG=$(cat .jitconfig) || exit 1
        rm -f .jitconfig
        export ACTIONS_RUNNER_INPUT_JITCONFIG
        exec ./run.sh' _ "$RUNNER_DIR"
    rc=$?
    set -e
    rm -f "$handoff"
    log "runner exited ($rc)"
  done
}

# Run only when executed; test-hooks.sh sources this file to test step 0.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
