#!/usr/bin/env python3
"""Run the real smoke's check/report sections without launching a native app."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("packaged-smoke.sh")


class SmokeGates(unittest.TestCase):
    def smoke(self, failed_gate="", missing_check=False):
        text = SCRIPT.read_text()
        reporting = text[text.index("failures=0"):text.index("# Wait until `pattern`")]
        checks = text[text.index("# (a) The sidecar booted."):text.index('screencapture -x')]
        finish = text[text.index('if [ "$reported" -ne "$EXPECTED_CHECKS" ]'):]
        # No native app, bd workspace or real wait: controlled OS boundaries,
        # actual reporting functions, check branches and final exit status.
        setup = r'''
WS=$PWD
LOG=$PWD/sidecar.log
TASK_B=sm-task
: > "$LOG"
bd() { return 0; }
sleep() { :; }
count_log() { echo 0; }
wait_log() {
  case "$1" in
    *beadbox-sidecar*) gate=sidecar ;;
    *ws:health*) gate=handshake ;;
    *'list completed'*) gate=tree ;;
    *change-detector*) gate=subscription ;;
    *) return 1 ;;
  esac
  [ "$gate" != "$FAILED_GATE" ]
}
'''
        # The five checks outside this extracted section retain their accounting.
        other_checks = '\n'.join('pass "' + name + '"' for name in
                                 ("launch", "quit", "updater version", "updater url", "updater signature"))
        if missing_check:
            other_checks = other_checks.replace('pass "quit"', '')
        with tempfile.TemporaryDirectory(prefix="smoke-gates-") as tmp:
            result = subprocess.run(["bash", "-uo", "pipefail", "-c",
                                     reporting + setup + checks + other_checks + '\n' + finish],
                                    cwd=tmp, env=dict(os.environ, FAILED_GATE=failed_gate),
                                    text=True, capture_output=True, timeout=10)
        print(f"gate={failed_gate or 'live-update-only'} missing={missing_check}: exit={result.returncode}\n{result.stdout}")
        return result

    def test_hidden_live_update_warns_but_does_not_fail_smoke(self):
        result = self.smoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("::warning::live update:", result.stdout)
        self.assertIn("harness defect", result.stdout)
        self.assertIn("not on the console", result.stdout)
        self.assertIn("beadbox-l6u", result.stdout)
        self.assertIn("0 failure(s)", result.stdout)

    def test_still_gating_failures_remain_red_with_live_update_warning(self):
        for gate in ("sidecar", "handshake", "tree", "subscription"):
            with self.subTest(gate=gate):
                result = self.smoke(gate)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("FAIL  " + gate + ":", result.stdout)
                self.assertIn("::warning::live update:", result.stdout)
                self.assertIn("1 failure(s)", result.stdout)

    def test_unreported_check_still_fails_smoke(self):
        result = self.smoke(missing_check=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL  harness:", result.stdout)


if __name__ == "__main__":
    unittest.main()
