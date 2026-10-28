// beadbox-id1 (GH #59): updateBeadsStatus(ids, status, dbPath?) — the bulk
// status loop behind the selection toolbar's Status control.
//
// Reuses the bd-workspace fixture (3 seed beads + 1 epic) for an isolated
// tmpdir bd run. Verifies:
//   1. Empty array returns success with no work
//   2. Multi-id success — bd show reports the new status for each
//   3. "closed" goes through bd close, including an already-closed bead
//   4. Partial failure — an invalid id mixed in reports per-id; others apply
//   5. An invalid status is reported per id and writes nothing
//   6. A flag-shaped id is refused per id before bd runs; others still apply

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import * as beads from "../handlers/beads"
import { showBead } from "../lib/bd"
import { BD_WORKSPACE_TIMEOUT_MS, createBdWorkspace, type Workspace } from "./fixtures/bd-workspace"

setDefaultTimeout(BD_WORKSPACE_TIMEOUT_MS)

let ws: Workspace

beforeAll(async () => {
  ws = await createBdWorkspace()
})

afterAll(async () => {
  await ws?.cleanup()
})

async function getStatus(id: string): Promise<string> {
  const bead = await showBead(id, { db: ws.dbPath })
  return bead.status
}

describe("handlers/beads.updateBeadsStatus (beadbox-id1)", () => {
  test("empty ids array returns success with no per-id results", async () => {
    const r = await beads.updateBeadsStatus([], "in_progress", ws.dbPath)
    expect(r.success).toBe(true)
    expect(r.results).toEqual([])
  })

  test("sets the status on every id and bd show reports it", async () => {
    const ids = [ws.seedIds.test1, ws.seedIds.test2]
    const r = await beads.updateBeadsStatus(ids, "in_progress", ws.dbPath)
    expect(r.success).toBe(true)
    expect(r.results).toEqual(ids.map((id) => ({ id, success: true })))
    for (const id of ids) {
      expect(await getStatus(id)).toBe("in_progress")
    }
  })

  test("closed closes every id, an already-closed bead included", async () => {
    await beads.closeBead(ws.seedIds.test3, ws.dbPath)
    const ids = [ws.seedIds.test1, ws.seedIds.test3]
    const r = await beads.updateBeadsStatus(ids, "closed", ws.dbPath)
    expect(r.success).toBe(true)
    expect(r.results.every((x) => x.success)).toBe(true)
    for (const id of ids) {
      const bead = await showBead(id, { db: ws.dbPath })
      expect(bead.status).toBe("closed")
      // bd close stamps closed_at, as the close path does
      expect((bead as unknown as { closed_at?: string }).closed_at).toBeTruthy()
    }
  })

  test("partial failure: a missing id reports failure, the others still update", async () => {
    const r = await beads.updateBeadsStatus(
      ["bb-does-not-exist", ws.seedIds.test2],
      "blocked",
      ws.dbPath,
    )
    expect(r.success).toBe(false)
    expect(r.results.map((x) => x.id)).toEqual(["bb-does-not-exist", ws.seedIds.test2])
    const bad = r.results[0]
    expect(bad.success).toBe(false)
    expect(bad.error).toBeTruthy()
    expect(r.results[1]).toEqual({ id: ws.seedIds.test2, success: true })
    expect(await getStatus(ws.seedIds.test2)).toBe("blocked")
  })

  test("an invalid status is reported per id and writes nothing", async () => {
    const before = await getStatus(ws.seedIds.epic1)
    const r = await beads.updateBeadsStatus([ws.seedIds.epic1], "no_such_status", ws.dbPath)
    expect(r.success).toBe(false)
    expect(r.results[0].success).toBe(false)
    expect(r.results[0].error).toContain("invalid status")
    expect(await getStatus(ws.seedIds.epic1)).toBe(before)
  })

  test("a flag-shaped id is refused before bd runs; the others still update", async () => {
    const hostile = "--db=/tmp/evil"
    const r = await beads.updateBeadsStatus([hostile, ws.seedIds.epic1], "deferred", ws.dbPath)
    expect(r.success).toBe(false)
    expect(r.results[0].id).toBe(hostile)
    expect(r.results[0].success).toBe(false)
    expect(r.results[0].error).toContain("BdArgvError")
    expect(r.results[1]).toEqual({ id: ws.seedIds.epic1, success: true })
    expect(await getStatus(ws.seedIds.epic1)).toBe("deferred")
  })
})
