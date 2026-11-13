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
bd() { : > "$WS/.changed"; return 0; }
sleep() { :; }
count_log() {
  case "$1" in
    *'trigger":"initial'*) echo 0 ;;
    *SUBSCRIPTION*)
      if [ "$FAILED_GATE" = "live-update" ] || [ ! -e "$WS/.changed" ]; then echo 0; else echo 1; fi
      ;;
    *'list completed'*) echo 1 ;;
    *) echo 0 ;;
  esac
}
wait_log() {
  case "$1" in
    *beadbox-sidecar*) gate=sidecar ;;
    *ws:health*) gate=handshake ;;
    *'list completed'*)
      if [ "$2" -ge 2 ]; then
        gate=live-update
        [ "${3:-0}" -ge 60 ] || return 1
      else
        gate=tree
      fi
      ;;
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
        print(f"gate={failed_gate or 'all-pass'} missing={missing_check}: exit={result.returncode}\n{result.stdout}")
        return result

    def test_all_gates_pass_when_live_update_allows_hidden_interval(self):
        result = self.smoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS  live update:", result.stdout)
        self.assertIn("the UI refetched in ", result.stdout)
        self.assertNotIn("::warning::live update:", result.stdout)
        self.assertIn("0 failure(s)", result.stdout)

    def test_live_update_failure_fails_smoke_without_warning_bypass(self):
        result = self.smoke("live-update")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("FAIL  live update: no change event and refetch within 60s of 'bd update'", result.stdout)
        self.assertNotIn("::warning::live update:", result.stdout)
        self.assertIn("1 failure(s)", result.stdout)

    def test_other_gating_failures_remain_red(self):
        for gate in ("sidecar", "handshake", "tree", "subscription"):
            with self.subTest(gate=gate):
                result = self.smoke(gate)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("FAIL  " + gate + ":", result.stdout)
                self.assertIn("1 failure(s)", result.stdout)

    def test_unreported_check_still_fails_smoke(self):
        result = self.smoke(missing_check=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL  harness:", result.stdout)


if __name__ == "__main__":
    unittest.main()
