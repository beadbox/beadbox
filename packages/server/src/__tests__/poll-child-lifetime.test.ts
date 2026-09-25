// The server-mode poll child must die with its parent (beadbox-db6).
//
// The sidecar spawns a /bin/sh poll loop that runs `bd sql` once a second. On
// quit, Tauri SIGKILLs the sidecar, so no cleanup hook runs; before this fix
// the loop was reparented to init and kept polling (and restarting Dolt) until
// the workspace next changed. The guarantee has to hold for EVERY way the
// parent can die — a clean exit, a crash, SIGKILL, SIGTERM — so each path is
// exercised here against the real spawn code.
//
// The proof is a count of the processes themselves, not a pgrep for the
// sidecar (that check passed while this bug was live, because the orphan's
// command is /bin/sh). The fake bd runs a sleep with a unique duration, so an
// in-flight bd is always part of what must disappear.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn as spawnProcess } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOST = join(import.meta.dir, "fixtures", "poll-child-host.ts")
const RUN = `db6x${process.pid}x${Date.now()}`
// A sleep duration no other process on the machine will be using.
const SLEEP = `3${String(process.pid).slice(-3)}.${Date.now() % 10000}`

let root: string
let db: string
let fakeBd: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), `${RUN}-`))
  db = join(root, "ws", ".beads")
  await mkdir(db, { recursive: true })
  // A genuine workspace marker: the loop refuses to run bd on a .beads
  // without one (beadbox-fdk).
  await writeFile(join(db, "metadata.json"), "{}")
  fakeBd = join(root, "bin-bd")
  // A bd whose `sql` never returns within the test: the loop is always
  // mid-call, which is exactly when an orphan does the most damage.
  await writeFile(fakeBd, `#!/bin/sh\nsleep ${SLEEP}\necho '[]'\n`, { mode: 0o700 })
})

afterAll(async () => {
  // Never leave the red run's orphans behind.
  killStragglers()
  await rm(root, { recursive: true, force: true })
})

interface Proc {
  pid: number
  ppid: number
  command: string
}

function ours(): Proc[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString()
  return out
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
    .filter((p) => p.command.includes(RUN) || p.command.includes(`sleep ${SLEEP}`))
}

function killStragglers(): void {
  for (const p of ours()) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {
      /* gone */
    }
  }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return predicate()
}

/** Start a host running the real poll-child spawn; resolve once bd is in flight. */
async function startHost(mode: string, id: string) {
  const host = spawnProcess("bun", [HOST], {
    env: { ...process.env, BD_PATH: fakeBd, HOST_DB: db, HOST_ID: `${RUN}-${id}`, HOST_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()))
  // Positive control: the loop shell and its in-flight bd must be SEEN before
  // their absence can mean anything.
  const up = await waitFor(() => {
    const procs = ours().filter(
      (p) => p.command.includes(id) || p.command.includes(`sleep ${SLEEP}`),
    )
    return (
      procs.some((p) => p.command.includes(`sleep ${SLEEP}`)) &&
      procs.some((p) => p.command.includes(id))
    )
  }, 5_000)
  return { host, exited, up }
}

const EXIT_PATHS: Array<[string, string, (pid: number) => void]> = [
  ["clean exit (process.exit)", "exit", () => {}],
  ["crash (uncaught throw)", "crash", () => {}],
  ["kill -9 (SIGKILL, what Tauri's quit sends)", "hang", (pid) => process.kill(pid, "SIGKILL")],
  ["SIGTERM", "hang", (pid) => process.kill(pid, "SIGTERM")],
]

describe("the server-mode poll child and its bd die with the parent, whatever kills it", () => {
  for (const [label, mode, kill] of EXIT_PATHS) {
    test(label, async () => {
      const id = label.split(" ")[0].replace(/\W/g, "")
      const { host, exited, up } = await startHost(mode, id)
      expect(up).toBe(true)
      if (host.pid === undefined) throw new Error("host did not start")
      kill(host.pid)
      await exited

      // Count every process from this run: the poll loop shell, the fake bd,
      // and its sleep. Nothing may outlive the parent by more than a moment.
      const gone = await waitFor(() => ours().length === 0, 3_000)
      const left = ours().map((p) => `${p.pid} ppid=${p.ppid} ${p.command.slice(0, 80)}`)
      killStragglers()
      expect({ gone, left }).toEqual({ gone: true, left: [] })
    }, 15_000)
  }
})
