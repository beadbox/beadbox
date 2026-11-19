// beadbox-0b6: one detector per workspace, newest start wins. A start that
// missed the client's 45 s deadline still reaches the sidecar and used to
// leave a server-mode poll child nobody owned (four at once on the QA Mac
// after one restart). Synthetic server-mode workspace with a fake bd on
// BD_PATH, so each detector runs a real poll child. No Dolt.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { start, stop } from "../handlers/subscribe"
import { _resetWriter, _setWriter, state } from "../handlers/subscribe-internals"
import { resetPathCaches } from "../lib/bd-paths"

const originalBdPath = process.env.BD_PATH
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beadbox-0b6-newest-"))
  const bd = join(root, "bd")
  writeFileSync(bd, `#!/bin/sh\necho '[{"issues":"same"}]'\n`, { mode: 0o700 })
  process.env.BD_PATH = bd
  resetPathCaches()
  _setWriter(() => {})
})

afterEach(async () => {
  for (const id of [...state.detectors.keys()]) await stop(id)
  _resetWriter()
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  resetPathCaches()
  rmSync(root, { recursive: true, force: true })
})

function serverWorkspace(name: string): string {
  const beads = join(root, name, ".beads")
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

test("three starts on one server-mode workspace leave one poll child (beadbox-0b6)", async () => {
  const beads = serverWorkspace("ws")
  await start(beads)
  await start(beads)
  const last = await start(beads)

  expect(await until(() => pollShells() >= 1, 5_000)).toBe(true)
  // Give any extra children time to show before counting.
  await Bun.sleep(500)
  expect(pollShells()).toBe(1)
  expect([...state.detectors.keys()]).toEqual([last.id])

  await stop(last.id)
  expect(await until(() => pollShells() === 0, 5_000)).toBe(true)
})

test("starts in flight together leave one poll child (beadbox-0b6)", async () => {
  const beads = serverWorkspace("ws")
  const [, , last] = await Promise.all([start(beads), start(beads), start(beads)])

  expect(await until(() => pollShells() >= 1, 5_000)).toBe(true)
  await Bun.sleep(500)
  expect(pollShells()).toBe(1)
  expect([...state.detectors.keys()]).toEqual([last.id])
})
