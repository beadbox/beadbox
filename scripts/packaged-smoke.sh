#!/usr/bin/env bash
# Packaged-app smoke test for macOS (beadbox-rgc). Runs on a CI runner against
# a built Beadbox.app; it launches the app, so never run it on a machine
# someone is working on.
#
# Nothing can drive a WKWebView from outside on macOS (Playwright does not
# attach to it and tauri-driver does not support macOS), so the app is checked
# from the outside: its sidecar's log, process state, bd on the runner, and the
# updater endpoint. Each check prints PASS or FAIL with its evidence; any FAIL
# makes the script exit 1.
#
# Shared Macs (beadbox-449.5): the runner may be the QA Mac, with other copies
# of Beadbox running. The script verifies the bundle's signature and team
# before launching it, and touches only its own launch: processes are found by
# this run's app path or workspace path and this user, and stopped by SIGTERM
# to that pid and its children, never by name or bundle id.
#
# Usage: packaged-smoke.sh <path/to/Beadbox.app> <release tag> <artifact dir>
#   The tag selects which latest.json and updater bundle to verify. For a
#   release that is still a draft, set SMOKE_MANIFEST and SMOKE_BUNDLE to local
#   copies of its latest.json and Beadbox_aarch64.app.tar.gz: draft assets are
#   not public yet.

set -uo pipefail

APP=${1:?path to Beadbox.app}
TAG=${2:?release tag, e.g. v0.27.0}
OUT=${3:?artifact directory}
REPO=${SMOKE_REPO:-beadbox/beadbox}
TEAM_ID=K7Z8YKVA8G
ME=$(id -u)
# The sidecar's log and registry live in this run's scratch dir, passed to the
# app at launch (BEADBOX_LOG_PATH, BEADBOX_REGISTRY_PATH), so the smoke never
# deletes or rewrites the user's own ~/.beadbox or ~/Library/Logs files.
SCRATCH="${RUNNER_TEMP:-$(mktemp -d)}/packaged-smoke"
LOG="$SCRATCH/beadbox-sidecar.log"
REGISTRY="$SCRATCH/registry.json"
WS="$SCRATCH/smoke-workspace"

mkdir -p "$OUT"
failures=0
reported=0
# Every check below must report PASS or FAIL. A check that errors out without
# reporting (a shell error inside its condition skips both branches) would
# otherwise leave a green run that never checked it.
EXPECTED_CHECKS=10
started=$(date +%s)
pass() { echo "PASS  $1"; reported=$((reported + 1)); }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); reported=$((reported + 1)); }
elapsed() { echo "$(($(date +%s) - started))s"; }

# Wait until `pattern` appears in the sidecar log at least `count` times.
wait_log() { # pattern, count, timeout seconds
  local pattern=$1 count=$2 timeout=$3 n=0
  for ((i = 0; i < timeout; i++)); do
    n=$(count_log "$pattern")
    [ "${n:-0}" -ge "$count" ] && return 0
    sleep 1
  done
  return 1
}
# grep -c prints 0 AND exits 1 on no match, so never add a fallback echo.
count_log() {
  local n
  n=$(grep -cE -- "$1" "$LOG" 2>/dev/null)
  echo "${n:-0}"
}

# ---------------------------------------------------------------------------
# Seed: a synthetic embedded workspace (an epic, two tasks, a blocks edge),
# registered and active, so the app has a tree to load.
# ---------------------------------------------------------------------------
rm -rf "$SCRATCH"
mkdir -p "$WS"
(
  cd "$WS" || exit 1
  git init -q && git -c user.email=smoke@example.invalid -c user.name=smoke commit -q --allow-empty -m init
  bd init --prefix=sm --non-interactive --skip-agents --skip-hooks >/dev/null
) || { fail "seed: bd init failed"; exit 1; }
id_of() { python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])'; }
EPIC=$(cd "$WS" && bd create "Smoke epic" -t epic --json | id_of)
TASK_A=$(cd "$WS" && bd create "Smoke task A" -t task --parent "$EPIC" --json | id_of)
TASK_B=$(cd "$WS" && bd create "Smoke task B" -t task --json | id_of)
(cd "$WS" && bd dep add "$TASK_A" "$TASK_B" >/dev/null)
WS_ID=$(python3 -c 'import uuid;print(uuid.uuid4())')
python3 - "$REGISTRY" "$WS_ID" "$WS/.beads" <<'EOF'
import json, sys, datetime
path, wid, beads = sys.argv[1:4]
json.dump({"version": 2, "activeWorkspace": wid, "workspaces": [{
    "id": wid, "name": "smoke-workspace", "addedAt": datetime.datetime.utcnow().isoformat() + "Z",
    "local": {"path": beads}, "server": None, "mode": "embedded"}]}, open(path, "w"))
EOF
echo "seed: workspace $WS (epic $EPIC, $TASK_A blocked by $TASK_B), bd $(bd --version | awk '{print $3}')"

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
# Verify before anything runs it: intact, accepted by Gatekeeper, our team.
# A bundle that fails here is never launched.
team=$(codesign -dv --verbose=2 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')
if codesign --verify --deep --strict "$APP" 2>"$OUT/codesign.err" \
  && spctl --assess --type execute "$APP" 2>"$OUT/spctl.err" \
  && [ "$team" = "$TEAM_ID" ]; then
  echo "verified: signature intact, Gatekeeper accepts it, team $team"
else
  echo "FAIL  verify: refusing to launch $APP (team '$team'; codesign: $(head -1 "$OUT/codesign.err"); spctl: $(head -1 "$OUT/spctl.err"))"
  exit 1
fi

open -n --env "BEADBOX_LOG_PATH=$LOG" --env "BEADBOX_REGISTRY_PATH=$REGISTRY" "$APP" \
  || { fail "launch: open failed"; exit 1; }
APP_PID=""
for ((i = 0; i < 30; i++)); do
  APP_PID=$(pgrep -U "$ME" -f "^$APP/Contents/MacOS/beadbox\$" | head -1)
  [ -n "$APP_PID" ] && break
  sleep 1
done
if [ -n "$APP_PID" ]; then pass "launch: app process $APP_PID ($(elapsed))"; else fail "launch: no app process after 30s"; fi

# (a) The sidecar booted.
if wait_log '\[beadbox-sidecar\] starting' 1 60; then
  pass "sidecar: booted ($(elapsed)) — $(grep -m1 -E '\[beadbox-sidecar\] starting' "$LOG")"
else
  fail "sidecar: no boot line in $LOG after 60s"
fi

# (b) Handshake: the webview reached the sidecar over the channel (the startup
# health check only runs when the UI calls it).
if wait_log '\[ws:health\]' 1 60; then
  pass "handshake: the UI's startup health call reached the sidecar ($(elapsed))"
else
  fail "handshake: no startup health call from the UI within 60s"
fi

# (c) Tree: the UI asked for the tree (bd list) and subscribed to live updates.
if wait_log '\[bd\] list completed' 1 60; then
  pass "tree: bd list served to the UI ($(elapsed))"
else
  fail "tree: no bd list within 60s of launch"
fi
if wait_log "\[change-detector\] starting for .*smoke-workspace" 1 30; then
  pass "subscription: live-update subscription started for the workspace"
else
  fail "subscription: no change-detector start for the workspace"
fi

# (d) Live update: a CLI write reaches the app, which refetches. An event is a
# subscription line with "type":"change"; the one sent at subscribe time is
# marked "trigger":"initial". Count real events as all change events minus
# initial ones, which holds whatever other fields an event carries (newer
# builds add a "trigger" naming the file that changed). The "change detected
# for" log line exists only on the server-mode poll path, so it is not used.
count_changes() {
  local all initial
  all=$(count_log '\[SUBSCRIPTION:[^]]+\] \{"type":"change"')
  initial=$(count_log '\[SUBSCRIPTION:[^]]+\] \{"type":"change".*"trigger":"initial"')
  echo $((all - initial))
}
wait_changes() { # count, timeout seconds
  for ((i = 0; i < $2; i++)); do
    [ "$(count_changes)" -ge "$1" ] && return 0
    sleep 1
  done
  return 1
}
lists_before=$(count_log '\[bd\] list completed')
changes_before=$(count_changes)
(cd "$WS" && bd update "$TASK_B" --status in_progress >/dev/null)
if wait_changes $((changes_before + 1)) 30 &&
  wait_log '\[bd\] list completed' $((lists_before + 1)) 30; then
  pass "live update: bd update → change detected → the UI refetched ($(elapsed))"
else
  fail "live update: no change event and refetch within 30s of 'bd update'"
fi

screencapture -x "$OUT/app.png" 2>/dev/null || echo "note: screencapture unavailable on this runner"

# ---------------------------------------------------------------------------
# Quit cleanly and leave nothing behind
# ---------------------------------------------------------------------------
# Quit by SIGTERM to this launch's own process and the processes it started.
# No AppleScript: on an unattended Mac session an Apple Event can wait on a
# consent prompt nobody answers, and by name or bundle id it could reach
# another copy of Beadbox (beadbox-449.2 test).
quit_method="SIGTERM to its own pid"
CHILDREN=""
[ -n "$APP_PID" ] && CHILDREN=$(pgrep -P "$APP_PID" | tr '\n' ' ')
for p in $APP_PID $CHILDREN; do kill -TERM "$p" 2>/dev/null; done
for ((i = 0; i < 20; i++)); do
  pgrep -U "$ME" -f "^$APP/Contents/MacOS/beadbox\$" >/dev/null || break
  sleep 1
done
sleep 5 # the sidecar's parent-death watcher polls every few seconds
# Only this run's processes: the app and sidecar by this bundle's path, bd by
# this run's workspace path (every bd call carries it). Other users' and other
# copies' processes are neither counted nor touched.
left_app=$(pgrep -U "$ME" -f "^$APP/Contents/MacOS/beadbox\$" | wc -l | tr -d ' ')
left_sidecar=$(pgrep -U "$ME" -f "$APP/Contents/MacOS/beadbox-sidecar" | wc -l | tr -d ' ')
left_bd=$(pgrep -U "$ME" -f "bd .*$WS" | wc -l | tr -d ' ')
if [ "$left_app$left_sidecar$left_bd" = "000" ]; then
  pass "quit via $quit_method: 0 app, 0 sidecar, 0 bd processes left ($(elapsed))"
else
  fail "quit via $quit_method: left app=$left_app sidecar=$left_sidecar bd=$left_bd"
  pgrep -U "$ME" -lf "$APP/|$WS" >"$OUT/leftovers.txt" 2>&1 || true
fi

# ---------------------------------------------------------------------------
# Updater: the manifest for this release, and a signature the app accepts
# ---------------------------------------------------------------------------
UPD="$OUT/updater"
mkdir -p "$UPD"
LOCAL_MANIFEST=${SMOKE_MANIFEST:-}
LOCAL_BUNDLE=${SMOKE_BUNDLE:-}
if [ -n "$LOCAL_MANIFEST" ]; then
  cp "$LOCAL_MANIFEST" "$UPD/latest.json"
  got_manifest=$?
else
  curl -fsSL "https://github.com/$REPO/releases/download/$TAG/latest.json" -o "$UPD/latest.json"
  got_manifest=$?
fi
if [ "$got_manifest" -eq 0 ]; then
  read -r m_version m_url m_sig < <(python3 - "$UPD/latest.json" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
p = m.get("platforms", {}).get("darwin-aarch64", {})
print(m.get("version", "-"), p.get("url", "-"), "yes" if p.get("signature") else "no")
EOF
  )
  if [ "$m_version" = "${TAG#v}" ]; then pass "updater: latest.json version $m_version"; else fail "updater: latest.json version '$m_version' for tag $TAG"; fi
  expected_url="https://github.com/$REPO/releases/download/$TAG/Beadbox_aarch64.app.tar.gz"
  if [ -n "$LOCAL_BUNDLE" ]; then
    # A draft's asset URL only resolves once the release is published, so
    # check that it is the URL publishing will make live.
    if [ "$m_sig" = "yes" ] && [ "$m_url" = "$expected_url" ]; then
      pass "updater: darwin-aarch64 entry points at this release's bundle and is signed"
    else
      fail "updater: darwin-aarch64 url '$m_url' (want $expected_url), signature=$m_sig"
    fi
  elif [ "$m_sig" = "yes" ] && curl -fsIL -o /dev/null "$m_url"; then
    pass "updater: darwin-aarch64 bundle resolves and is signed"
  else
    fail "updater: darwin-aarch64 url or signature missing ($m_url, signature=$m_sig)"
  fi
  # The app verifies the bundle with the minisign key in tauri.conf.json; do
  # the same with that key.
  python3 - "$UPD/latest.json" "$UPD" <<'EOF'
import base64, json, os, sys
m = json.load(open(sys.argv[1])); out = sys.argv[2]
conf = json.load(open(os.path.join("src-tauri", "tauri.conf.json")))
open(os.path.join(out, "key.pub"), "wb").write(base64.b64decode(conf["plugins"]["updater"]["pubkey"]))
open(os.path.join(out, "bundle.minisig"), "wb").write(base64.b64decode(m["platforms"]["darwin-aarch64"]["signature"]))
EOF
  if { if [ -n "$LOCAL_BUNDLE" ]; then cp "$LOCAL_BUNDLE" "$UPD/bundle.tar.gz"; else curl -fsSL "$m_url" -o "$UPD/bundle.tar.gz"; fi; } &&
    minisign -Vm "$UPD/bundle.tar.gz" -p "$UPD/key.pub" -x "$UPD/bundle.minisig" >"$UPD/minisign.out" 2>&1; then
    pass "updater: bundle signature verifies against the app's public key"
  else
    fail "updater: signature verification failed ($(tail -1 "$UPD/minisign.out"))"
  fi
else
  fail "updater: no latest.json for $TAG"
fi

cp "$LOG" "$OUT/beadbox-sidecar.log" 2>/dev/null || true
if [ "$reported" -ne "$EXPECTED_CHECKS" ]; then
  fail "harness: only $((reported)) of $EXPECTED_CHECKS checks reported a result"
fi
echo "---- $((failures)) failure(s), $(elapsed) total"
[ "$failures" -eq 0 ]
