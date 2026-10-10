// beadbox-z04: a page that attaches to an already-running sidecar (after the
// host reloaded a page WebKit had killed) stops the previous page's
// subscriptions, so one page means one set of detectors. Synthetic
// workspaces: one embedded (manifest watch), one server mode (fake bd on
// BD_PATH, a real poll child). No Dolt.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handlers } from "../handlers"
import { start, stop } from "../handlers/subscribe"
import { state } from "../handlers/subscribe-internals"
import { resetPathCaches } from "../lib/bd-paths"

const originalBdPath = process.env.BD_PATH
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beadbox-z04-session-"))
  const bd = join(root, "bd")
  writeFileSync(bd, `#!/bin/sh\necho '[{"issues":"same"}]'\n`, { mode: 0o700 })
  process.env.BD_PATH = bd
  resetPathCaches()
})

afterEach(async () => {
  for (const id of [...state.detectors.keys()]) await stop(id)
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  resetPathCaches()
  rmSync(root, { recursive: true, force: true })
})

function embeddedWorkspace(): string {
  const beads = join(root, "embedded", ".beads")
  const manifest = join(beads, "embeddeddolt", "bb", ".dolt", "noms")
  mkdirSync(manifest, { recursive: true })
  writeFileSync(join(manifest, "manifest"), "5:__DOLT__:root")
  writeFileSync(join(beads, "metadata.json"), JSON.stringify({ dolt_mode: "embedded" }))
  return beads
}

function serverWorkspace(): string {
  const beads = join(root, "server", ".beads")
  mkdirSync(beads, { recursive: true })
  writeFileSync(join(beads, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))
  writeFileSync(join(beads, "dolt-server.port"), "3999")
  return beads
}

/** Poll-loop shells of THIS test, matched by its unique root path. */
function pollShells(): number {
  const out = Bun.spawnSync(["ps", "-axo", "ppid=,command="]).stdout.toString()
  return out.split("\n").filter((l) => l.trim().startsWith(`${process.pid} `) && l.includes(root))
    .length
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await Bun.sleep(50)
  }
  return check()
}

test("attached() stops every subscription the previous page left behind", async () => {
  const before = state.detectors.size
  const a = await start(embeddedWorkspace())
  const b = await start(serverWorkspace())
  expect(state.detectors.has(a.id)).toBe(true)
  expect(state.detectors.has(b.id)).toBe(true)
  // The server-mode subscription really has a poll loop running.
  expect(await until(() => pollShells() >= 1, 5_000)).toBe(true)

  const result = await handlers.session.attached()

  expect(result.stopped).toBe(before + 2)
  expect(state.detectors.size).toBe(0)
  expect(state.paths.size).toBe(0)
  expect(await until(() => pollShells() === 0, 5_000)).toBe(true)
})

test("attached() on a fresh sidecar stops nothing", async () => {
  expect(await handlers.session.attached()).toEqual({ stopped: 0 })
})

test("a subscription started after attached() is the only one", async () => {
  await start(embeddedWorkspace())
  await handlers.session.attached()
  const fresh = await start(embeddedWorkspace())
  expect([...state.detectors.keys()]).toEqual([fresh.id])
})
