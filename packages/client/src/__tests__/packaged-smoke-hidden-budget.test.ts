import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import * as lifecycleModule from "../hooks/use-workspace-lifecycle"

// The packaged smoke runs with a hidden window on unattended macOS runner
// sessions, so its live-update refetch timeout must exceed the client's hidden
// refresh interval plus enough headroom for bd list to complete (beadbox-1jq).
test("packaged-smoke.sh live-update refetch timeout covers HIDDEN_REFRESH_INTERVAL_MS", () => {
  const intervalMs =
    (lifecycleModule as { HIDDEN_REFRESH_INTERVAL_MS?: number }).HIDDEN_REFRESH_INTERVAL_MS ??
    30_000
  const scriptPath = resolve(import.meta.dir, "../../../../scripts/packaged-smoke.sh")
  const script = readFileSync(scriptPath, "utf8")

  // Match the live-update wait_log call: wait_log '\[bd\] list completed' $((lists_before + 1)) <timeout>
  const varMatch = script.match(/^LIVE_UPDATE_TIMEOUT=([0-9]+)$/m)
  const callMatch = script.match(
    /wait_log\s+'\\\[bd\\\] list completed'\s+\$\(\(lists_before \+ 1\)\)\s+"?(\$?\{?LIVE_UPDATE_TIMEOUT\}?|[0-9]+)"?/,
  )
  expect(callMatch).not.toBeNull()

  const rawArg = callMatch?.[1] ?? ""
  const timeoutSec = rawArg.includes("LIVE_UPDATE_TIMEOUT")
    ? Number(varMatch?.[1] ?? NaN)
    : Number(rawArg)

  const minRequiredSec = Math.ceil(intervalMs / 1_000) + 15
  expect(timeoutSec).toBeGreaterThanOrEqual(minRequiredSec)
})
