#!/usr/bin/env bash
# Display lifecycle for the packaged smoke. Source only; no app is launched here.
SMOKE_DISPLAY_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/packaged-smoke-window.swift"
SMOKE_CAFFEINATE_PID=""
SMOKE_DISPLAY_DIAGNOSED=0

smoke_display_diagnose() {
  [ "$SMOKE_DISPLAY_DIAGNOSED" -eq 0 ] || return 0
  SMOKE_DISPLAY_DIAGNOSED=1
  echo "display diagnostics: frontmost app and on-screen windows (front to back)"
  swift "$SMOKE_DISPLAY_HELPER" diagnose >"$OUT/display.txt" 2>&1 || true
  cat "$OUT/display.txt"
  screencapture -x "$OUT/display-failure.png" 2>/dev/null \
    || echo "note: display failure screenshot unavailable"
}

smoke_display_cleanup() {
  local result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then smoke_display_diagnose; fi
  if [ -n "$SMOKE_CAFFEINATE_PID" ]; then
    kill -TERM "$SMOKE_CAFFEINATE_PID" 2>/dev/null || true
    wait "$SMOKE_CAFFEINATE_PID" 2>/dev/null || true
    echo "display: released own caffeinate PID $SMOKE_CAFFEINATE_PID"
  fi
  exit "$result"
}

smoke_display_start() {
  trap smoke_display_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo "display: waking with caffeinate -u -t 3"
  caffeinate -u -t 3 || return 1
  caffeinate -d -u &
  SMOKE_CAFFEINATE_PID=$!
  echo "display: holding caffeinate -d -u (own PID $SMOKE_CAFFEINATE_PID)"
}

smoke_display_front() {
  if swift "$SMOKE_DISPLAY_HELPER" front "$1"; then
    return 0
  fi
  echo "FAIL  window not visible: cannot foreground smoke app PID $1 (see display diagnostics)"
  smoke_display_diagnose
  return 1
}
