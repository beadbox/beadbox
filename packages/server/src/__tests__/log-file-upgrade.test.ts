// beadbox-qyl: the first boot of a new sidecar build must not append to a log
// written by an earlier build. Before v0.27 the log was rewritten on every
// boot, so a secret leaked into it lived until the next launch; with the
// append-only log (beadbox-01f.4) it would otherwise survive the upgrade for
// months. The old content (and its rotated .1) is deleted, not kept.
//
// Every boot is its own process, as the real sidecar is, with BEADBOX_LOG_PATH
// on a temp file so no real log is touched.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const logFile = join(import.meta.dir, "..", "lib", "log-file.ts")
const SECRET = "BEADS_DOLT_PASSWORD=fake-secret-qyl-5f3a"
let dir: string
let log: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beadbox-qyl-"))
  log = join(dir, "beadbox-sidecar.log")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** One sidecar boot of build `build` that writes one line, then exits. */
function boot(build: string, line: string, extra = ""): void {
  const script = `const m = await import(${JSON.stringify(logFile)})
m._setBuildIdForTests?.(${JSON.stringify(build)})
${extra}
m.logFileWrite(${JSON.stringify(line)})
m.closeLogFile()`
  const { BEADBOX_LOG_PATH: _inherited, ...env } = process.env
  const r = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...env, BEADBOX_LOG_PATH: log },
  })
  expect(r.exitCode).toBe(0)
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "")

test("a pre-upgrade log and its .1 are deleted on the first boot; the secret survives nowhere", () => {
  // What 0.26.x leaves behind: a header without build=, and a leaked secret.
  const old = `\n--- 2026-09-01T00:00:00.000Z sidecar boot pid=4242 ---\n[shutdown] env ${SECRET}\n`
  writeFileSync(log, old)
  writeFileSync(`${log}.1`, old)

  boot("A", "first v0.27 line")

  expect(read(log)).not.toContain(SECRET)
  expect(read(log)).toContain("first v0.27 line")
  expect(existsSync(`${log}.1`)).toBe(false)
})

test("same build relaunched: appends, nothing lost", () => {
  boot("A", "boot one")
  boot("A", "boot two")
  const text = read(log)
  expect(text).toContain("boot one")
  expect(text).toContain("boot two")
  expect(text.match(/sidecar boot pid=/g)).toHaveLength(2)
})

test("a different build starts fresh", () => {
  boot("A", `A wrote ${SECRET}`)
  boot("B", "B line")
  expect(read(log)).not.toContain(SECRET)
  expect(read(log)).toContain("B line")
})

test("after a rotation, a same-build relaunch still appends (the rotated header names the build)", () => {
  // Force a rotation within one boot, then relaunch the same build.
  boot(
    "A",
    "x".repeat(3000),
    `m._setLogRotationForTests({ maxBytes: 1000, checkEvery: 1 })
m.logFileWrite("fill ${"y".repeat(1500)}")`,
  )
  const afterRotation = read(log)
  boot("A", "relaunch line")
  const text = read(log)
  expect(text).toContain("relaunch line")
  expect(text.startsWith(afterRotation)).toBe(true)
})

test("fresh install: the log is created with a build-stamped header", () => {
  boot("A", "hello")
  expect(read(log)).toMatch(/sidecar boot pid=\d+ build=A/)
})
