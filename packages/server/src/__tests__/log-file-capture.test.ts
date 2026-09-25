// The sidecar log captures what the change detector emitted, stays bounded,
// and never holds a credential (beadbox-01f.4).
//
// #41 made the log append-only (log-file-append.test.ts). Two gaps remained:
// the server-mode poll child writes its [SUBSCRIPTION:] lines straight to the
// inherited stderr fd, so they never reached the log, and an append-only log
// grows forever. Each case runs in its own process, as the real sidecar does,
// with BEADBOX_LOG_PATH pointed at a temp file so the real log is untouched.

import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const lib = join(import.meta.dir, "..", "lib")
let dir: string | null = null

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), "beadbox-logcap-"))
  return dir
}

test("the poll child's change line reaches the log file; a credential never does", async () => {
  const root = scratch()
  const log = join(root, "sidecar.log")
  const beads = join(root, "ws", ".beads")
  mkdirSync(beads, { recursive: true })
  const counter = join(root, "counter")
  writeFileSync(counter, "0")
  const secret = "S3cret-01f4-probe"
  // Each `bd sql` answers something different, so the second poll sees a
  // change; it also prints the password to stderr, the way a chatty CLI might.
  const fakeBd = join(root, "bd")
  writeFileSync(
    fakeBd,
    `#!/bin/sh\nn=$(cat "${counter}")\necho $((n + 1)) > "${counter}"\necho "password is $BEADS_DOLT_PASSWORD" >&2\necho "[{\\"h\\":\\"$n\\"}]"\n`,
    { mode: 0o700 },
  )
  const script = `
    const bd = await import(${JSON.stringify(join(lib, "bd.ts"))})
    const cd = await import(${JSON.stringify(join(lib, "change-detector.ts"))})
    bd.setWorkspacePassword(${JSON.stringify(join(root, "ws"))}, ${JSON.stringify(secret)})
    const state = { dbPath: ${JSON.stringify(beads)}, stopped: false, emit: () => {}, pollChild: null }
    cd._startServerPollChild(state, "f4-capture")
    await new Promise((r) => setTimeout(r, 3500))
    state.pollChild?.kill("SIGKILL")
    process.exit(0)
  `
  const { BEADBOX_LOG_PATH: _inherited, ...env } = process.env
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { ...env, BEADBOX_LOG_PATH: log, BD_PATH: fakeBd },
    stdout: "ignore",
    stderr: "pipe",
  })
  const wire = await new Response(proc.stderr).text()
  expect(await proc.exited).toBe(0)

  // The wire (stderr) carries the event exactly as before ...
  expect(wire).toContain('[SUBSCRIPTION:f4-capture] {"type":"change"')
  // ... and the log file now has the same line.
  const text = existsSync(log) ? readFileSync(log, "utf8") : ""
  expect(text).toContain('[SUBSCRIPTION:f4-capture] {"type":"change"')
  // No credential anywhere in the log, including what bd printed.
  expect(text).not.toContain(secret)
}, 20_000)

function run(script: string, env: Record<string, string>) {
  const { BEADBOX_LOG_PATH: _inherited, ...base } = process.env
  const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...base, ...env } })
  expect(r.exitCode).toBe(0)
}

test("the log rotates at the cap and keeps one previous generation, in order", () => {
  const root = scratch()
  const log = join(root, "sidecar.log")
  run(
    `const m = await import(${JSON.stringify(join(lib, "log-file.ts"))})
     m._setLogRotationForTests({ maxBytes: 2000, checkEvery: 5 })
     for (let i = 0; i < 60; i++) m.logFileWrite("line-" + String(i).padStart(3, "0") + " " + "x".repeat(40))
     m.closeLogFile()`,
    { BEADBOX_LOG_PATH: log },
  )
  expect(existsSync(`${log}.1`)).toBe(true)
  const current = readFileSync(log, "utf8")
  expect(current.length).toBeLessThan(4000)
  // The newest line is in the current file; lines never run backwards.
  expect(current).toContain("line-059")
  const both = readFileSync(`${log}.1`, "utf8") + current
  const seen = [...both.matchAll(/line-(\d{3})/g)].map((m) => Number(m[1]))
  expect(seen).toEqual([...seen].sort((a, b) => a - b))
})

test("an instance whose log was rotated by another instance follows it to the new file", async () => {
  const root = scratch()
  const log = join(root, "sidecar.log")
  const go = join(root, "go")
  const mod = JSON.stringify(join(lib, "log-file.ts"))
  const { BEADBOX_LOG_PATH: _inherited, ...base } = process.env
  // A opens the log, waits while B fills and rotates it, then writes again.
  const a = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const m = await import(${mod})
       m._setLogRotationForTests({ maxBytes: 2000, checkEvery: 1 })
       m.logFileWrite("A-before")
       const fs = await import("node:fs")
       while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 50))
       m.logFileWrite("A-after-rotation")
       m.closeLogFile()`,
    ],
    { env: { ...base, BEADBOX_LOG_PATH: log } },
  )
  await new Promise((r) => setTimeout(r, 500))
  run(
    `const m = await import(${mod})
     m._setLogRotationForTests({ maxBytes: 2000, checkEvery: 1 })
     for (let i = 0; i < 60; i++) m.logFileWrite("B-" + i + " " + "y".repeat(40))
     m.closeLogFile()`,
    { BEADBOX_LOG_PATH: log },
  )
  writeFileSync(go, "")
  expect(await a.exited).toBe(0)
  expect(existsSync(`${log}.1`)).toBe(true)
  // A's late line is in the live file, not stranded in the rotated one.
  expect(readFileSync(log, "utf8")).toContain("A-after-rotation")
}, 20_000)
