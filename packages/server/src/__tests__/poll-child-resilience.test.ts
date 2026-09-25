// The server-mode poll child must not go silently dark (beadbox-01f.2).
//
// Three ways it used to: a bd sql that never returns froze the loop forever
// (no bound), a child that exited was never replaced (one polling_error, then
// silence), and nothing told the client the stream was healthy, so silence
// was indistinguishable from "no changes". Each is exercised here against the
// real shell loop and the real spawn code, with a fake bd. No Dolt, no real
// workspace.

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetPathCaches } from "../lib/bd-paths"
import * as detector from "../lib/change-detector"
import type { SubscriptionEvent } from "../subscribe-protocol"

setDefaultTimeout(60_000)

const RUN = `f2x${process.pid}x${Date.now()}`
const TIMEOUT_S = 2
// Reads through the namespace: a detector that predates the override still
// loads, and these tests then fail on behaviour rather than on import.
const overrides = detector._testOverrides as Record<string, number | null>

let root: string
let db: string
const children: ChildProcess[] = []
// The supervision test points BD_PATH at a fake bd. Bun runs every test file
// in one process, so it must be put back or later bd-backed suites hit the fake.
const originalBdPath = process.env.BD_PATH

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), `${RUN}-`))
  db = join(root, "ws", ".beads")
  await mkdir(db, { recursive: true })
})

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGKILL")
    } catch {
      /* gone */
    }
  }
  overrides.pollTimeoutS = null
  overrides.respawnBaseMs = null
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  resetPathCaches()
})

afterAll(async () => {
  for (const p of ours()) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {
      /* gone */
    }
  }
  await rm(root, { recursive: true, force: true })
})

function ours(): Array<{ pid: number; ppid: number; command: string }> {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString()
  return out
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
    .filter((p) => p.command.includes(RUN))
}

async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await pred()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return pred()
}

/** A fake bd: records each invocation, then behaves per `body`. */
async function fakeBd(name: string, body: string): Promise<{ path: string; log: string }> {
  const path = join(root, `bd-${name}`)
  const log = join(root, `${name}.log`)
  await writeFile(path, `#!/bin/sh\necho "$$" >> "${log}"\n${body}\n`, { mode: 0o700 })
  return { path, log }
}

async function invocations(log: string): Promise<number[]> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter(Boolean).map(Number)
  } catch {
    return []
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Run the real poll loop directly; collect its SUBSCRIPTION lines. */
function runLoop(id: string, bdPath: string) {
  const args = (detector.buildPollShellArgs as (...a: unknown[]) => string[])(
    `${RUN}-${id}`,
    db,
    bdPath,
    TIMEOUT_S,
  )
  const child = spawn("/bin/sh", args, { stdio: ["pipe", "ignore", "pipe"], detached: true })
  children.push(child)
  const lines: string[] = []
  child.stderr?.on("data", (b: Buffer) => lines.push(...b.toString().split("\n").filter(Boolean)))
  return { child, lines }
}

describe("each poll is bounded (AC3)", () => {
  test("a bd sql that never returns is killed and polling continues", async () => {
    const bd = await fakeBd("hang", `exec sleep 600 # ${RUN}`)
    runLoop("hang", bd.path)
    expect(await until(async () => (await invocations(bd.log)).length >= 1, 5_000)).toBe(true)
    const [first] = await invocations(bd.log)
    // Within the bound (+1s TERM->KILL grace) the loop has moved on.
    expect(
      await until(async () => (await invocations(bd.log)).length >= 2, (TIMEOUT_S + 8) * 1000),
    ).toBe(true)
    expect(alive(first)).toBe(false)
  })

  test("a SIGSTOPped bd (SIGTERM stays pending) is still killed", async () => {
    const bd = await fakeBd("stop", `kill -STOP $$\necho '[]'`)
    runLoop("stop", bd.path)
    expect(await until(async () => (await invocations(bd.log)).length >= 1, 5_000)).toBe(true)
    const [first] = await invocations(bd.log)
    expect(
      await until(async () => (await invocations(bd.log)).length >= 2, (TIMEOUT_S + 8) * 1000),
    ).toBe(true)
    expect(alive(first)).toBe(false)
  })
})

describe("a healthy stream says so (heartbeat, AC4)", () => {
  test("a successful poll emits a heartbeat", async () => {
    const bd = await fakeBd("ok", `echo '[{"issues":"h1"}]'`)
    const { lines } = runLoop("ok", bd.path)
    expect(await until(() => lines.some((l) => l.includes('"type":"heartbeat"')), 4_000)).toBe(true)
  })

  test("a failing poll never heartbeats; the error sequence is unchanged", async () => {
    const bd = await fakeBd("fail", "exit 1")
    const { lines } = runLoop("fail", bd.path)
    // 3 failures (5s apart after each) reach polling_error.
    expect(await until(() => lines.some((l) => l.includes('"type":"polling_error"')), 20_000)).toBe(
      true,
    )
    expect(lines.some((l) => l.includes('"type":"heartbeat"'))).toBe(false)
  })
})

describe("a dead poll child is replaced (AC2)", () => {
  test("kill -9 of the child: a new one within 5s, reconnecting emitted; none after stop()", async () => {
    overrides.respawnBaseMs = 200
    const bd = await fakeBd("sup", `echo '[{"issues":"h1"}]'`)
    process.env.BD_PATH = bd.path
    resetPathCaches()
    const beads = join(root, "sup", ".beads")
    await mkdir(beads, { recursive: true })
    await writeFile(join(beads, "dolt-server.port"), "3999")
    const events: SubscriptionEvent[] = []
    const id = `${RUN}-sup`
    const d = await detector.createChangeDetector(beads, (e) => events.push(e), id)
    try {
      // The loop shell is OUR child. Its db6 parent-death watcher is a forked
      // subshell with the same argv, so match on the parent, not the command.
      const loopPids = () => ours().filter((p) => p.ppid === process.pid && p.command.includes(id))
      expect(await until(() => loopPids().length >= 1, 5_000)).toBe(true)
      const [original] = loopPids()
      process.kill(original.pid, "SIGKILL")
      const t0 = Date.now()
      expect(await until(() => loopPids().some((p) => p.pid !== original.pid), 5_000)).toBe(true)
      expect(Date.now() - t0).toBeLessThanOrEqual(5_000)
      expect(events.some((e) => e.type === "reconnecting")).toBe(true)
    } finally {
      await d.stop()
    }
    const afterStop = ours().filter((p) => p.command.includes(id)).length
    await new Promise((r) => setTimeout(r, 1500))
    expect(ours().filter((p) => p.command.includes(id)).length).toBe(0)
    expect(afterStop).toBeLessThanOrEqual(1)
  })
})
