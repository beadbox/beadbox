// Removing a workspace stops the sidecar's change detection for it
// (beadbox-wja). The client is expected to move its subscription off a
// removed workspace; this is the sidecar-side backstop, so the server-mode
// poll loop can never outlive its workspace's registration.
//
// Synthetic server: a fake bd on BD_PATH answers the poll query; no Dolt.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetPathCaches } from "../lib/bd-paths"
import { removeActiveWorkspace } from "../handlers/health"
import { start, stop } from "../handlers/subscribe"
import { state } from "../handlers/subscribe-internals"
import { removeWorkspace } from "../handlers/workspaces"

const original = {
  BD_PATH: process.env.BD_PATH,
  BEADBOX_REGISTRY_PATH: process.env.BEADBOX_REGISTRY_PATH,
  BEADS_REGISTRY_PATH: process.env.BEADS_REGISTRY_PATH,
}
let root: string
let beads: string
const WS_ID = "3f1b8a24-0000-4000-8000-00000000a1a1"

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beadbox-wja-"))
  beads = join(root, "ws", ".beads")
  mkdirSync(beads, { recursive: true })
  writeFileSync(
    join(beads, "metadata.json"),
    JSON.stringify({ dolt_mode: "server", dolt_database: "wja" }),
  )
  const bd = join(root, "bd")
  writeFileSync(bd, `#!/bin/sh\necho '[{"h":"1"}]'\n`, { mode: 0o700 })
  process.env.BD_PATH = bd
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
  process.env.BEADS_REGISTRY_PATH = join(root, "legacy.json")
  resetPathCaches()
  writeFileSync(
    join(root, "registry.json"),
    JSON.stringify({
      version: 2,
      activeWorkspace: WS_ID,
      workspaces: [
        {
          id: WS_ID,
          name: "wja",
          addedAt: "2026-09-25T00:00:00.000Z",
          local: { path: beads },
          server: null,
          mode: "server",
        },
      ],
    }),
  )
})

afterEach(async () => {
  for (const id of [...state.detectors.keys()]) await stop(id).catch(() => {})
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetPathCaches()
  rmSync(root, { recursive: true, force: true })
})

/** Poll-loop shells for THIS test's workspace (the loop passes it as $2). */
function pollLoops(): number {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]).stdout.toString()
  const lines = out.split("\n").filter((l) => l.includes("DOLT_HASHOF_TABLE") && l.includes(root))
  const pids = new Set(lines.map((l) => Number(l.trim().split(/\s+/)[0])))
  // Roots: loop shells whose parent is not itself one of these shells.
  return lines.filter((l) => !pids.has(Number(l.trim().split(/\s+/)[1]))).length
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return predicate()
}

describe("removing a workspace stops its server-mode poll loop", () => {
  test("via removeWorkspace(databasePath)", async () => {
    const { id } = await start(beads)
    expect(await until(() => pollLoops() === 1, 3_000)).toBe(true)
    expect(await removeWorkspace(beads)).toMatchObject({ success: true })
    expect(await until(() => pollLoops() === 0, 3_000)).toBe(true)
    expect(state.detectors.has(id)).toBe(false)
  }, 15_000)

  test("via removeActiveWorkspace(id)", async () => {
    const { id } = await start(beads)
    expect(await until(() => pollLoops() === 1, 3_000)).toBe(true)
    expect(await removeActiveWorkspace(WS_ID)).toMatchObject({ removed: true })
    expect(await until(() => pollLoops() === 0, 3_000)).toBe(true)
    expect(state.detectors.has(id)).toBe(false)
  }, 15_000)
})
