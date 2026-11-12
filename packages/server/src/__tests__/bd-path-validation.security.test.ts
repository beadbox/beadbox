import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getBdPathSelection, resetPathCaches, resolveBdPath, validateBdPath } from "../lib/bd-paths"
import { setBdPath } from "../handlers/bd-settings"

let root: string
const saved = { config: process.env.BEADBOX_SETTINGS_PATH, bd: process.env.BD_PATH }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beadbox-path-security-"))
  process.env.BEADBOX_SETTINGS_PATH = join(root, "settings.json")
  delete process.env.BD_PATH
  resetPathCaches()
})
afterEach(() => {
  for (const [key, value] of [["BEADBOX_SETTINGS_PATH", saved.config], ["BD_PATH", saved.bd]]) {
    if (value === undefined) delete process.env[key!]
    else process.env[key!] = value
  }
  resetPathCaches()
  rmSync(root, { recursive: true, force: true })
})
function fake(name = "bd", mode = 0o700) {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\ntouch '${join(root, "executed")}'\necho 'bd version 1.3.1'\n`, { mode })
  chmodSync(path, mode)
  return path
}
test("save refuses a non-bd basename before executing its version probe", async () => {
  await expect(setBdPath(fake("other"))).rejects.toThrow()
  expect(existsSync(join(root, "executed"))).toBe(false)
  expect(existsSync(process.env.BEADBOX_SETTINGS_PATH!)).toBe(false)
})
test.each(["./bd", "tools/bd", "bd", "/tmp/bd\0", "/tmp/other"])("read ignores unsafe saved path %j without disclosing it", (path) => {
  writeFileSync(process.env.BEADBOX_SETTINGS_PATH!, JSON.stringify({ bdPath: path }))
  const warning = spyOn(console, "warn").mockImplementation(() => {})
  try {
    expect(getBdPathSelection()).toMatchObject({ source: "automatic", savedPath: null })
    expect(warning).toHaveBeenCalled()
    expect(warning.mock.calls.flat().join(" ")).toBe(
      "[bd:settings] Invalid saved bd path; using automatic detection",
    )
  } finally {
    warning.mockRestore()
  }
})
test.each([0o720, 0o702, 0o777])("save refuses writable target mode %o before probe", async (mode) => {
  await expect(validateBdPath(fake("bd", mode))).rejects.toThrow()
  expect(existsSync(join(root, "executed"))).toBe(false)
})
test("every spawn resolution rechecks saved target permissions without a probe", async () => {
  const path = fake()
  await setBdPath(path)
  unlinkSync(join(root, "executed"))
  expect(resolveBdPath()).toBe(path)
  expect(existsSync(join(root, "executed"))).toBe(false)
  chmodSync(path, 0o777)
  expect(resolveBdPath()).not.toBe(path)
  expect(getBdPathSelection().source).toBe("automatic")
  expect(existsSync(join(root, "executed"))).toBe(false)
})
test("read rechecks a replaced symlink target, while basename uses the given path", async () => {
  const target = fake("real-binary")
  mkdirSync(join(root, "shim"))
  const path = join(root, "shim", "bd")
  symlinkSync(target, path)
  await setBdPath(path)
  expect(resolveBdPath()).toBe(path)
  const unsafe = fake("unsafe-target", 0o777)
  unlinkSync(path)
  symlinkSync(unsafe, path)
  expect(resolveBdPath()).not.toBe(path)
})
test("test preload always provides a scratch settings file", () => {
  const preload = join(import.meta.dir, "_test-log-isolation.ts")
  const child = Bun.spawnSync([process.execPath, "--preload", preload, "-e", "console.log(process.env.BEADBOX_SETTINGS_PATH)"], {
    env: { ...process.env, BEADBOX_SETTINGS_PATH: "" }, stdout: "pipe",
  })
  expect(child.exitCode).toBe(0)
  expect(child.stdout.toString().trim()).toContain("beadbox-test-")
})

test("save and read refuse a target owned by another user before probing", async () => {
  const path = fake()
  writeFileSync(process.env.BEADBOX_SETTINGS_PATH!, JSON.stringify({ bdPath: path }))
  // Keep the actual file/stat boundary; simulate a different calling uid only.
  const uid = spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1)
  try {
    await expect(validateBdPath(path)).rejects.toThrow("owned")
    expect(getBdPathSelection().source).toBe("automatic")
    expect(existsSync(join(root, "executed"))).toBe(false)
  } finally {
    uid.mockRestore()
  }
})
test("save follows symlinks for writability before any version probe", async () => {
  const target = fake("target", 0o777)
  const path = join(root, "bd")
  symlinkSync(target, path)
  await expect(setBdPath(path)).rejects.toThrow("writable")
  expect(existsSync(join(root, "executed"))).toBe(false)
})
test("read rejects an existing non-bd executable without executing it", () => {
  writeFileSync(process.env.BEADBOX_SETTINGS_PATH!, JSON.stringify({ bdPath: fake("other") }))
  expect(getBdPathSelection().source).toBe("automatic")
  expect(existsSync(join(root, "executed"))).toBe(false)
})
