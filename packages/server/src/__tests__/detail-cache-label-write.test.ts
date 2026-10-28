// beadbox-o9a: the detail cache served stale labels after a bd label write.
//
// getBeadDetail caches the full bead and called an entry fresh while the tree
// bead's updated_at and comment count matched. bd's label writes move neither,
// so after `bd update --add-label` (from the CLI, an agent, another client) the
// open detail panel, and a reopen, kept the old labels indefinitely.
//
// Real bd against a seeded tmpdir workspace. Each case writes with the CLI,
// then calls incrementalRefresh (what the client does on the change event),
// then reads the detail. BD_PATH points at a wrapper that logs every argv the
// SIDECAR runs, so the idle control can count `bd show` calls. The fixture's
// own writes use `bd` from PATH and are not logged.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as epics from "../handlers/epics"
import { __resetBdPathCache, getBdPath } from "../lib/bd"
import { BD_WORKSPACE_TIMEOUT_MS, createBdWorkspace, runBdInWorkspace, type Workspace } from "./fixtures/bd-workspace"

setDefaultTimeout(BD_WORKSPACE_TIMEOUT_MS)

let ws: Workspace
let log: string
const originalBdPath = process.env.BD_PATH

beforeAll(async () => {
  ws = await createBdWorkspace()
  __resetBdPathCache()
  const realBd = getBdPath()
  log = join(ws.root, "sidecar-bd.log")
  const wrapper = join(ws.root, "bd-logging")
  await writeFile(wrapper, `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realBd}" "$@"\n`)
  await chmod(wrapper, 0o700)
  process.env.BD_PATH = wrapper
  __resetBdPathCache()
})

afterAll(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  __resetBdPathCache()
  await ws?.cleanup()
})

async function showCalls(): Promise<number> {
  try {
    return (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line.split(" ").includes("show")).length
  } catch {
    return 0
  }
}

async function cliUpdatedAt(id: string): Promise<string> {
  const out = JSON.parse(await runBdInWorkspace(["show", id, "--json"], ws.root))
  return (Array.isArray(out) ? out[0] : out).updated_at
}

/** Detail as the panel gets it after a change event: refresh the tree, then read. */
async function detailAfterChange(id: string) {
  const tree = await epics.incrementalRefresh(ws.dbPath)
  expect(tree.success).toBe(true)
  return epics.getBeadDetail(id, ws.dbPath)
}

describe("detail cache after bd writes that do not bump updated_at (beadbox-o9a)", () => {
  test("a label added with the bd CLI reaches the next detail read", async () => {
    const id = ws.seedIds.test1
    // Warm the tree and the detail cache.
    expect((await detailAfterChange(id))?.labels ?? []).not.toContain("o9a-added")
    const before = await cliUpdatedAt(id)

    await runBdInWorkspace(["update", id, "--add-label=o9a-added"], ws.root)
    // The premise this bug rests on: bd's label write leaves updated_at alone.
    expect(await cliUpdatedAt(id)).toBe(before)

    expect((await detailAfterChange(id))?.labels ?? []).toContain("o9a-added")
  })

  test("a label removed with the bd CLI leaves the next detail read", async () => {
    const id = ws.seedIds.test1
    expect((await detailAfterChange(id))?.labels ?? []).toContain("o9a-added")
    await runBdInWorkspace(["update", id, "--remove-label=o9a-added"], ws.root)
    expect((await detailAfterChange(id))?.labels ?? []).not.toContain("o9a-added")
  })

  test("idle: with no write, detail reads are cache hits (no bd show)", async () => {
    const id = ws.seedIds.test2
    await detailAfterChange(id) // warm
    const before = await showCalls()
    for (let i = 0; i < 3; i++) {
      expect(await detailAfterChange(id)).not.toBeNull()
    }
    expect(await showCalls()).toBe(before)
  })

  test("controls: a comment add and a status change still refresh", async () => {
    const id = ws.seedIds.test2
    await detailAfterChange(id) // warm
    await runBdInWorkspace(["comments", "add", id, "o9a control comment"], ws.root)
    const afterComment = await detailAfterChange(id)
    expect(afterComment?.comments.map((c) => c.content)).toContain("o9a control comment")

    await runBdInWorkspace(["update", id, "--status=in_progress"], ws.root)
    expect((await detailAfterChange(id))?.status).toBe("in_progress")
  })

  test("the logging wrapper sees the sidecar's bd calls (probe control)", async () => {
    // Without this, a broken wrapper would make the idle test pass vacuously.
    expect(await showCalls()).toBeGreaterThan(0)
  })
})
