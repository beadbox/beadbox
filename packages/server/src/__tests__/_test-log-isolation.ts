// Preloaded before every server test file (bunfig.toml). Tests that spawn the
// real sidecar entry inherit this environment, and the sidecar mirrors its
// stderr into BEADBOX_LOG_PATH or, when unset, the user's real log
// (~/Library/Logs/Beadbox/beadbox-sidecar.log on macOS). Without this, every
// test run and every pre-push hook appended test sidecars' output, shutdown
// stamps included, to the log users attach to bug reports (beadbox-9j1).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (!process.env.BEADBOX_LOG_PATH) {
  process.env.BEADBOX_LOG_PATH = join(mkdtempSync(join(tmpdir(), "beadbox-test-log-")), "beadbox-sidecar.log")
}
