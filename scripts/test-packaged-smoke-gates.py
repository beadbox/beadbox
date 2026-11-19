#!/usr/bin/env python3
"""Run the real smoke's check/report sections without launching a native app."""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("packaged-smoke.sh")
# The first smoke targets (beadbox-79a): what v0.33.0's rc needed checked by hand.
TARGETS = ["all-projects", "status-colors-gray"]
VIEWS_OK = [{"target": t, "ok": True, "detail": "as expected"} for t in TARGETS]


class SmokeGates(unittest.TestCase):
    def smoke(self, failed_gate="", missing_check=False, refetch_at=30, list_only=False, views=None):
        text = SCRIPT.read_text()
        reporting = text[text.index("failures=0"):text.index("# ---------------------------------------------------------------------------\n# Seed:")]
        checks = text[text.index("# (a) The sidecar booted."):text.index('screencapture -x')]
        finish = text[text.index('if [ "$reported" -ne "$EXPECTED_CHECKS" ]'):]
        # No native app, bd workspace or real wait: controlled OS boundaries,
        # actual reporting functions, check branches and final exit status.
        setup = r'''
WS=$PWD
LOG=$PWD/sidecar.log
TASK_B=sm-task
echo 0 > "$WS/clock"
date() { cat "$WS/clock"; }
bd() { cat "$WS/clock" > "$WS/written"; }
sleep() {
  local t=$(cat "$WS/clock")
  t=$((t + 1))
  echo "$t" > "$WS/clock"
  if [ -e "$WS/written" ]; then
    local since_write=$((t - $(cat "$WS/written")))
    if [ "$since_write" -eq 1 ] && [ "$FAILED_GATE" != live ]; then
      echo '[SUBSCRIPTION:sm] {"type":"change","trigger":"manifest"}' >> "$LOG"
    fi
    if [ "$since_write" -eq "$REFETCH_AT" ] && [ "$FAILED_GATE" != live ]; then
      echo '[bd] list completed' >> "$LOG"
      if [ "$LIST_ONLY" != yes ]; then
        echo '[debug:cascade9] getEpicsCore N=1 db=smoke-workspace' >> "$LOG"
      fi
    fi
  fi
}
: > "$LOG"
started=0
[ "$FAILED_GATE" = sidecar ] || echo '[beadbox-sidecar] starting' >> "$LOG"
[ "$FAILED_GATE" = handshake ] || echo '[ws:health]' >> "$LOG"
if [ "$FAILED_GATE" != tree ]; then
  echo '[bd] list completed' >> "$LOG"
  echo '[debug:cascade9] getEpicsCore N=1 db=smoke-workspace' >> "$LOG"
fi
[ "$FAILED_GATE" = subscription ] || echo '[change-detector] starting for smoke-workspace' >> "$LOG"
# beadbox-79a: the release's named smoke targets and what the app reported
# for each from inside its WebView (one [smoke-view] JSON line per target).
SMOKE_TARGETS=$PWD/smoke-targets.json
printf '%s\n' "$TARGETS_JSON" > "$SMOKE_TARGETS"
[ -z "$VIEW_LINES" ] || printf '%s\n' "$VIEW_LINES" >> "$LOG"
'''
        # The five checks outside this extracted section retain their accounting.
        other_checks = '\n'.join('pass "' + name + '"' for name in
                                 ("launch", "quit", "updater version", "updater url", "updater signature"))
        if missing_check:
            other_checks = other_checks.replace('pass "quit"', '')
        with tempfile.TemporaryDirectory(prefix="smoke-gates-") as tmp:
            result = subprocess.run(["bash", "-uo", "pipefail", "-c",
                                     reporting + setup + checks + other_checks + '\n' + finish],
                                    cwd=tmp, env=dict(os.environ, FAILED_GATE=failed_gate, REFETCH_AT=str(refetch_at), LIST_ONLY="yes" if list_only else "no",
                                             TARGETS_JSON=json.dumps({"targets": [{"id": t} for t in TARGETS]}),
                                             VIEW_LINES="\n".join("[smoke-view] " + json.dumps(v) for v in (VIEWS_OK if views is None else views))),
                                    text=True, capture_output=True, timeout=10)
        print(f"gate={failed_gate or 'live-update-only'} missing={missing_check}: exit={result.returncode}\n{result.stdout}")
        return result

    def test_hidden_refetch_after_one_interval_passes(self):
        result = self.smoke(refetch_at=45)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS  live update:", result.stdout)
        self.assertIn("0 failure(s)", result.stdout)
        self.assertIn("change detected (1s)", result.stdout)
        self.assertIn("tree refetched in 45s", result.stdout)

    def test_blocked_by_list_alone_cannot_satisfy_tree_refetch(self):
        result = self.smoke(refetch_at=2, list_only=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("FAIL  live update:", result.stdout)

    def test_live_update_timeout_is_a_failure_again(self):
        result = self.smoke("live")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("FAIL  live update:", result.stdout)
        self.assertNotIn("::warning::live update:", result.stdout)

    def test_other_gates_still_fail(self):
        for gate in ("sidecar", "handshake", "tree", "subscription"):
            with self.subTest(gate=gate):
                result = self.smoke(gate)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("FAIL  " + gate + ":", result.stdout)
                self.assertIn("PASS  live update:", result.stdout)
                self.assertIn("1 failure(s)", result.stdout)

    def test_unreported_check_still_fails_smoke(self):
        result = self.smoke(missing_check=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL  harness:", result.stdout)

    # beadbox-79a: a release whose changed view is broken or blank must not pass.
    def test_named_views_that_render_as_expected_pass(self):
        result = self.smoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for target in TARGETS:
            self.assertIn("PASS  view: " + target, result.stdout)

    def test_a_blank_or_broken_changed_view_fails_the_smoke(self):
        # The app boots and serves the tree, but the All projects view never
        # reports from the WebView (it threw, or rendered nothing).
        result = self.smoke(views=[VIEWS_OK[1]])
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("FAIL  view: all-projects", result.stdout)

    def test_a_wrong_computed_color_fails_the_smoke(self):
        wrong = {"target": "status-colors-gray", "ok": False,
                 "detail": "badge background rgba(59, 130, 246, 0.2), want rgba(255, 0, 0, 0.2)"}
        result = self.smoke(views=[VIEWS_OK[0], wrong])
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("FAIL  view: status-colors-gray", result.stdout)
        self.assertIn("want rgba(255, 0, 0, 0.2)", result.stdout)


if __name__ == "__main__":
    unittest.main()
