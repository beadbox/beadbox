// bb-y729: archiveBeads(ids[], dbPath?) — bulk archive loop test.
//
// Reuses the bd-workspace fixture (3 seed beads + 1 epic) for an isolated
// tmpdir bd run. Verifies:
//   1. Empty array returns success with no work
//   2. Multi-id success — all get the 'archived' label
//   3. Existing-label preservation — pre-existing labels survive the archive
//   4. Partial failure — invalid id mixed with valid ones reports per-id

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

async function getLabels(id: string): Promise<string[]> {
  const bead = await showBead(id, { db: ws.dbPath })
  return bead.labels ?? []
}

describe("handlers/beads.archiveBeads (bb-y729)", () => {
  test("empty ids array returns success with no per-id results", async () => {
    const r = await beads.archiveBeads([], ws.dbPath)
    expect(r.success).toBe(true)
    expect(r.results).toEqual([])
  })

  test("archives multiple beads and labels are observable via bd show", async () => {
    const ids = [ws.seedIds.test1, ws.seedIds.test2]
    const r = await beads.archiveBeads(ids, ws.dbPath)
    expect(r.success).toBe(true)
    expect(r.results).toHaveLength(2)
    expect(r.results.every((x) => x.success)).toBe(true)

    for (const id of ids) {
      const labels = await getLabels(id)
      expect(labels).toContain("archived")
    }
  })

  test("preserves pre-existing labels on archived beads", async () => {
    // Seed a custom label on test3 before archiving
    await beads.addLabelAction(ws.seedIds.test3, "fixture-priority", ws.dbPath)
    const before = await getLabels(ws.seedIds.test3)
    expect(before).toContain("fixture-priority")

    const r = await beads.archiveBeads([ws.seedIds.test3], ws.dbPath)
    expect(r.success).toBe(true)

    const after = await getLabels(ws.seedIds.test3)
    expect(after).toContain("archived")
    expect(after).toContain("fixture-priority")
  })

  test("partial failure: bad id reports failure but other ids still archived", async () => {
    // epic1 hasn't been archived yet; mix it with a clearly invalid id
    const r = await beads.archiveBeads(["bb-does-not-exist", ws.seedIds.epic1], ws.dbPath)
    expect(r.success).toBe(false)
    expect(r.results).toHaveLength(2)

    const bad = r.results.find((x) => x.id === "bb-does-not-exist")
    const good = r.results.find((x) => x.id === ws.seedIds.epic1)
    expect(bad?.success).toBe(false)
    expect(bad?.error).toBeTruthy()
    expect(good?.success).toBe(true)

    const epicLabels = await getLabels(ws.seedIds.epic1)
    expect(epicLabels).toContain("archived")
  })
})
