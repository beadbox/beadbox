#!/usr/bin/env python3
"""Exercise smoke display lifecycle with fake OS tools, without launching an app."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class DisplayLifecycle(unittest.TestCase):
    def run_display(self, body, foreground_ok=True, production=False):
        with tempfile.TemporaryDirectory(prefix="smoke-display-") as tmp:
            root = Path(tmp)
            (root / "caffeinate").write_text(
                '#!/bin/bash\necho "caffeinate $*" >> "$TRACE"\n'
                'if [ "$1" = "-u" ]; then exit 0; fi\n'
                'echo $$ > "$ASSERTION_PID"\nexec /bin/sleep 60\n'
            )
            (root / "swift").write_text(
                '#!/bin/bash\necho "swift $*" >> "$TRACE"\n'
                'if [ "$2" = "front" ]; then exit ' + ("0" if foreground_ok else "1") + '; fi\n'
                'echo "frontmost: synthetic-cover (pid 5678)"\n'
            )
            (root / "screencapture").write_text(
                '#!/bin/bash\necho "screenshot $*" >> "$TRACE"\ntouch "${@: -1}"\n'
            )
            (root / "bd").write_text('#!/bin/bash\nexit 1\n')
            (root / "git").write_text('#!/bin/bash\nexit 0\n')
            (root / "open").write_text('#!/bin/bash\nexit 99\n')
            for name in ("caffeinate", "swift", "screencapture", "bd", "git", "open"):
                (root / name).chmod(0o755)
            env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}",
                       TRACE=str(root / "trace"), ASSERTION_PID=str(root / "pid"),
                       RUNNER_TEMP=str(root / "runner"))
            script = f'OUT="{root}"; source "{ROOT / "packaged-smoke-display.sh"}"\n' + body
            command = ["bash", "-c", script]
            if production:
                command = ["bash", str(ROOT / "packaged-smoke.sh"), str(root / "Fake.app"),
                           "v0.34.0-rc.1", str(root / "out")]
            result = subprocess.run(command, env=env, text=True,
                                    capture_output=True, timeout=10)
            trace = (root / "trace").read_text() if (root / "trace").exists() else ""
            pid = int((root / "pid").read_text()) if (root / "pid").exists() else None
            if pid:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            return result, trace

    def test_dark_display_is_woken_and_assertion_released_on_early_exit(self):
        result, trace = self.run_display('smoke_display_start; /bin/sleep .1; exit 7')
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertIn('caffeinate -u -t 3', trace)
        self.assertIn('caffeinate -d -u', trace)

    def test_foreground_targets_only_the_launched_pid(self):
        result, trace = self.run_display('smoke_display_start; smoke_display_front 1234; /bin/sleep .1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(' front 1234', trace)

    def test_failed_foreground_has_diagnostics_and_screenshot(self):
        result, trace = self.run_display(
            'smoke_display_start; smoke_display_front 1234 || exit 1', False)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('window not visible:', result.stdout)
        self.assertIn('frontmost: synthetic-cover', result.stdout)
        self.assertIn(' diagnose', trace)
        self.assertIn('screenshot -x', trace)

    def test_production_smoke_wakes_before_seed_and_cleans_up_on_seed_failure(self):
        result, trace = self.run_display('', production=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('seed: bd init failed', result.stdout)
        self.assertIn('caffeinate -u -t 3', trace)
        self.assertIn('caffeinate -d -u', trace)
        self.assertIn(' diagnose', trace)

    def test_signal_releases_own_assertion(self):
        result, _ = self.run_display('smoke_display_start; /bin/sleep .1; kill -TERM $$')
        self.assertEqual(result.returncode, 143, result.stderr)


if __name__ == '__main__':
    unittest.main()
