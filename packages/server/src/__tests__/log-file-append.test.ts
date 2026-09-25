import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Each "boot" runs in its own process, as the real sidecar does, with HOME and
// XDG_STATE_HOME pointed at a temp dir so the real log is never touched.
const logFile = join(import.meta.dir, "..", "lib", "log-file.ts")
let home: string | null = null

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = null
})

function boot(dir: string, line: string): void {
  const script = `const m = await import(${JSON.stringify(logFile)}); m.logFileWrite(${JSON.stringify(line)}); m.closeLogFile()`
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, HOME: dir, XDG_STATE_HOME: join(dir, "state"), LOCALAPPDATA: dir },
  })
  expect(result.exitCode).toBe(0)
}

function logPath(dir: string): string {
  if (process.platform === "darwin") return join(dir, "Library", "Logs", "Beadbox", "beadbox-sidecar.log")
  if (process.platform === "win32") return join(dir, "Beadbox", "Logs", "beadbox-sidecar.log")
  return join(dir, "state", "beadbox", "beadbox-sidecar.log")
}

test("a second sidecar boot appends to the log instead of overwriting it", () => {
  home = mkdtempSync(join(tmpdir(), "beadbox-log-"))
  boot(home, "first boot line")
  boot(home, "second boot line")

  const path = logPath(home)
  expect(existsSync(path)).toBe(true)
  const text = readFileSync(path, "utf8")
  expect(text.match(/sidecar boot pid=/g)).toHaveLength(2)
  const first = text.indexOf("first boot line")
  const second = text.indexOf("second boot line")
  expect(first).toBeGreaterThanOrEqual(0)
  expect(second).toBeGreaterThan(first)
})
