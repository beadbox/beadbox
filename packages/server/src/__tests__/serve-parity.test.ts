// Parity and freshness of routed reads against a REAL bd serve (beadbox-6x2
// L4). Through the real handlers: the same workspace read with serve off
// (CLI) and on (serve) must give the same tree, details and custom statuses,
// and a read through serve right after a CLI write must see the write.
//
// Needs a real bd >= 1.3.0: BEADBOX_TEST_BD_SERVE=/abs/path/to/bd. Without it
// this SKIPS with that reason; a skip is not a pass.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCustomStatusList } from "../handlers/beads"
import { getBeadDetail, getEpics } from "../handlers/epics"
import { __resetBdPathCache } from "../lib/bd"
import { invalidateEpicCache } from "../lib/epic-cache"
import { __resetServeReads, __serveReadsState, __settleServeStarts } from "../lib/serve-reads"

setDefaultTimeout(180_000)
const BD = process.env.BEADBOX_TEST_BD_SERVE
const SKIP = !BD
if (SKIP) console.warn("[serve-parity] SKIPPED: set BEADBOX_TEST_BD_SERVE to a bd >= 1.3.0 to run parity and freshness")

const ID = "33333333-3333-4333-8333-333333333333"
const saved = { registry: process.env.BEADBOX_REGISTRY_PATH, bd: process.env.BD_PATH }
let dir = ""
let beadsDir = ""
let regDir = ""
let ids: string[] = []
const bd = (args: string[]) => execFileSync(BD as string, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString()

function registry(serveReads: boolean): void {
  writeFileSync(
    process.env.BEADBOX_REGISTRY_PATH as string,
    JSON.stringify({
      version: 2,
      activeWorkspace: ID,
      workspaces: [{ id: ID, name: "parity", addedAt: "2026-09-25T00:00:00Z", local: { path: beadsDir }, server: null, mode: "server", serveReads }],
    }),
  )
}

async function readAll() {
  invalidateEpicCache()
  const tree = await getEpics(beadsDir)
  const details = []
  for (const id of ids) {
    invalidateEpicCache()
    details.push(await getBeadDetail(id, beadsDir))
  }
  return { tree, details, statuses: await getCustomStatusList(beadsDir) }
}

beforeAll(async () => {
  if (SKIP) return
  const parent = process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache")
  mkdirSync(parent, { recursive: true })
  dir = mkdtempSync(join(parent, "beadbox-parity-"))
  beadsDir = join(dir, ".beads")
  execFileSync("git", ["init", "-q"], { cwd: dir })
  bd(["init", "--server", "--prefix", "p", "--quiet", "--skip-agents", "--skip-hooks"])
  const epic = JSON.parse(bd(["create", "an epic", "--type", "epic", "--json"])).id as string
  const a = JSON.parse(bd(["create", "task a", "--parent", epic, "--json"])).id as string
  const b = JSON.parse(bd(["create", "task b", "--json"])).id as string
  bd(["dep", "add", b, a])
  bd(["comments", "add", a, "a comment"])
  bd(["config", "set", "status.custom", "review,qa"])
  ids = [epic, a, b]
  regDir = mkdtempSync(join(tmpdir(), "beadbox-parity-reg-"))
  process.env.BEADBOX_REGISTRY_PATH = join(regDir, "registry.json")
  process.env.BD_PATH = BD
  __resetBdPathCache()
  await __resetServeReads()
})

afterAll(async () => {
  await __resetServeReads()
  invalidateEpicCache()
  if (saved.registry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = saved.registry
  if (saved.bd === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = saved.bd
  __resetBdPathCache()
  if (dir.includes("beadbox-parity-")) {
    try {
      bd(["dolt", "stop"])
    } catch {
      /* not running */
    }
    rmSync(dir, { recursive: true, force: true })
  }
  if (regDir) rmSync(regDir, { recursive: true, force: true })
})

describe.skipIf(SKIP)("routed reads against a real bd serve", () => {
  test("serve on gives exactly what the CLI gives: tree, details, custom statuses", async () => {
    registry(false)
    const viaCli = await readAll()
    registry(true)
    await getCustomStatusList(beadsDir) // starts serve in the background (answered by the CLI)
    await __settleServeStarts()
    const state = [...__serveReadsState().workspaces.values()][0]
    expect(state?.client).toBeTruthy() // precondition: serve is actually in use
    expect(state?.disabled).toBeNull()
    const viaServe = await readAll()
    expect(viaServe).toEqual(viaCli)
    expect(viaCli.details.every((d) => d !== null)).toBe(true)
    expect(viaCli.statuses).toEqual(["review", "qa"])
  })

  test("a read through serve right after a CLI write sees the write", async () => {
    registry(true)
    await __settleServeStarts()
    for (let i = 0; i < 5; i++) {
      bd(["update", ids[1], "--title", `renamed ${i}`])
      bd(["comments", "add", ids[1], `fresh ${i}`])
      invalidateEpicCache()
      const d = await getBeadDetail(ids[1], beadsDir)
      expect(d?.title).toBe(`renamed ${i}`)
      expect(d?.comments.map((c) => c.content)).toContain(`fresh ${i}`)
      invalidateEpicCache()
      expect(JSON.stringify(await getEpics(beadsDir))).toContain(`renamed ${i}`)
    }
    expect([...__serveReadsState().workspaces.values()][0]?.client).toBeTruthy() // still serving
  })
})
