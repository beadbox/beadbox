// Unit tests for the system handler namespace.
//
// getLogDirectory is platform-dependent; we assert the platform-correct
// branch was hit. openInFileManager is exercised on the missing-directory
// path (no UI process spawn).

import { afterEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { getLogDirectory, openInFileManager } from "../handlers/system"

describe("system.getLogDirectory", () => {
  // The override is read at call time; each test sets or clears it and puts
  // back whatever the runner had.
  const saved = process.env.BEADBOX_LOG_PATH
  afterEach(() => {
    if (saved === undefined) delete process.env.BEADBOX_LOG_PATH
    else process.env.BEADBOX_LOG_PATH = saved
  })

  test("follows an absolute BEADBOX_LOG_PATH to the directory holding the log", async () => {
    const log = path.join(os.tmpdir(), "bb-local-profile", "sidecar.log")
    process.env.BEADBOX_LOG_PATH = log
    expect(await getLogDirectory()).toBe(path.dirname(log))
  })

  test("returns a platform-appropriate path containing 'Beadbox'", async () => {
    process.env.BEADBOX_LOG_PATH = "relative/sidecar.log" // ignored: not absolute
    const dir = await getLogDirectory()
    if (process.platform === "darwin") {
      expect(dir).toBe(path.join(os.homedir(), "Library", "Logs", "Beadbox"))
    } else if (process.platform === "linux") {
      expect(dir).toBe(path.join(os.homedir(), ".local", "share", "Beadbox", "logs"))
    } else if (process.platform === "win32") {
      const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      expect(dir).toBe(path.join(appdata, "Beadbox", "logs"))
    } else {
      expect(dir).toBeNull()
    }
  })
})

describe("system.openInFileManager", () => {
  test("missing directory returns { success: false, error: 'Directory not found' }", async () => {
    const result = await openInFileManager("/nonexistent/__bb_p1_4_test__/never/exists")
    expect(result.success).toBe(false)
    expect(result.error).toBe("Directory not found")
  })

  test("relative path is resolved before the existence check", async () => {
    // Same negative path, asserted via a relative input. resolve() turns it
    // into an absolute path the existsSync check will not find.
    const result = await openInFileManager("./__bb_p1_4_test_relative__/never/exists")
    expect(result.success).toBe(false)
    expect(result.error).toBe("Directory not found")
  })
})
