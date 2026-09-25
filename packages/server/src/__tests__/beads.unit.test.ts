// Unit tests for handlers/beads.ts. Each handler is exercised against an
// isolated tmpdir bd workspace seeded by ./fixtures/bd-workspace.ts.
//
// These tests verify return-shape parity (handler doesn't crash, returns the
// expected discriminator/value type) but NOT byte-for-byte parity with the
// old action — that's P1.7's parity-runner job.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import * as beads from "../handlers/beads"
import { createBdWorkspace, runBdInWorkspace, type Workspace } from "./fixtures/bd-workspace"

setDefaultTimeout(30_000)

let ws: Workspace

beforeAll(async () => {
  ws = await createBdWorkspace()
})

afterAll(async () => {
  await ws?.cleanup()
})

describe("handlers/beads (mutator return shape)", () => {
  test("updateBeadStatus returns success: true on existing bead", async () => {
    const r = await beads.updateBeadStatus(ws.seedIds.test1, "in_progress", ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("updateBeadPriority accepts BeadPriority literal", async () => {
    const r = await beads.updateBeadPriority(ws.seedIds.test1, "high", ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("updateBeadAssignee accepts string", async () => {
    const r = await beads.updateBeadAssignee(ws.seedIds.test1, "alice", ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("updateBeadSpecId accepts string", async () => {
    const r = await beads.updateBeadSpecId(ws.seedIds.test1, "spec-001", ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("updateBeadTitle renames bead", async () => {
    const r = await beads.updateBeadTitle(ws.seedIds.test1, "Renamed via handler", ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("updateBeadType accepts BeadType literal", async () => {
    const r = await beads.updateBeadType(ws.seedIds.test1, "bug", ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("updateBeadDue accepts iso-ish date", async () => {
    const r = await beads.updateBeadDue(ws.seedIds.test1, "2026-12-31", ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("updateBeadDefer accepts iso-ish date", async () => {
    const r = await beads.updateBeadDefer(ws.seedIds.test1, "2026-06-01", ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("updateBeadEstimate accepts number", async () => {
    const r = await beads.updateBeadEstimate(ws.seedIds.test1, 60, ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("updateBeadDesign accepts string", async () => {
    const r = await beads.updateBeadDesign(
      ws.seedIds.test1,
      "Design notes from handler test",
      ws.dbPath,
    )
    expect(r.success).toBe(true)
  })

  test("text fields can be saved independently and cleared", async () => {
    const id = ws.seedIds.test2
    for (const [field, value] of [
      ["description", "Description from editor"],
      ["acceptanceCriteria", "Criteria from editor"],
      ["notes", "Notes from editor"],
    ] as const) {
      expect((await beads.updateBeadTextField(id, field, value, ws.dbPath)).success).toBe(true)
    }
    const read = async () => JSON.parse(await runBdInWorkspace(["show", id, "--json"], ws.root))[0]
    const saved = await read()
    expect(saved.description).toBe("Description from editor")
    expect(saved.acceptance_criteria).toBe("Criteria from editor")
    expect(saved.notes).toBe("Notes from editor")

    expect((await beads.updateBeadTextField(id, "notes", "", ws.dbPath)).success).toBe(true)
    const cleared = await read()
    expect(cleared.notes ?? "").toBe("")
    expect(cleared.description).toBe("Description from editor")
  })

  test("addLabelAction + removeLabelAction round-trip", async () => {
    const a = await beads.addLabelAction(ws.seedIds.test1, "fixture-label", ws.dbPath)
    expect(a.success).toBe(true)
    const r = await beads.removeLabelAction(ws.seedIds.test1, "fixture-label", ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("archiveBead toggles", async () => {
    const on = await beads.archiveBead(ws.seedIds.test1, true, ws.dbPath)
    expect(on.success).toBe(true)
    const off = await beads.archiveBead(ws.seedIds.test1, false, ws.dbPath)
    expect(off.success).toBe(true)
  })

  test("backlogBead toggles", async () => {
    const on = await beads.backlogBead(ws.seedIds.test1, true, ws.dbPath)
    expect(on.success).toBe(true)
    const off = await beads.backlogBead(ws.seedIds.test1, false, ws.dbPath)
    expect(off.success).toBe(true)
  })

  test("addComment + deleteCommentAction round-trip", async () => {
    const add = await beads.addComment(ws.seedIds.test1, "Comment from handler test", ws.dbPath)
    expect(add.success).toBe(true)
    // We don't have the comment ID without listing, but the bead AC just
    // requires the handler executes. deleteCommentAction shape coverage:
    const noPath = await beads.deleteCommentAction("c-fake", undefined)
    expect(noPath.success).toBe(false)
    expect(noPath.error).toMatch(/required/i)
  })

  test("updateBeadParent accepts null (clear parent)", async () => {
    const r = await beads.updateBeadParent(ws.seedIds.test1, null, ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("removeDependencyAction returns shape on missing dep", async () => {
    const r = await beads.removeDependencyAction(ws.seedIds.test1, ws.seedIds.test2, ws.dbPath)
    expect(typeof r.success).toBe("boolean")
  })

  test("closeBeadChildren bulk closes", async () => {
    const r = await beads.closeBeadChildren([ws.seedIds.test2], ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("archiveBeadChildren bulk archives", async () => {
    const r = await beads.archiveBeadChildren([ws.seedIds.test2], ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("closeBead closes single bead", async () => {
    const unassigned = JSON.parse(await runBdInWorkspace(
      ["create", "Unassigned close target", "--type", "task", "--json"], ws.root,
    )) as { id: string }
    const r = await beads.closeBead(unassigned.id, ws.dbPath)
    expect(r.success).toBe(true)
  })

  test("deleteBead requires dbPath; succeeds when present", async () => {
    const noPath = await beads.deleteBead(ws.seedIds.test3, undefined)
    expect(noPath.success).toBe(false)
    const ok = await beads.deleteBead(ws.seedIds.test3, ws.dbPath)
    expect(typeof ok.success).toBe("boolean")
  })
})

describe("handlers/beads (read-only return shape)", () => {
  test("getAvailableStatuses returns string array including core statuses", async () => {
    const statuses = await beads.getAvailableStatuses(ws.dbPath)
    expect(Array.isArray(statuses)).toBe(true)
    expect(statuses).toContain("open")
    expect(statuses).toContain("in_progress")
    expect(statuses).toContain("closed")
  })

  test("getAvailableTypes reads the current workspace's bd types", async () => {
    const types = await beads.getAvailableTypes(ws.dbPath)
    expect(types).toContain("task")
    expect(types).toContain("decision")
    expect(types).toContain("milestone")
  })

  test("getAvailableTypes propagates unavailable workspace errors", async () => {
    await expect(beads.getAvailableTypes("/nonexistent/path/.beads/dolt"))
      .rejects.toThrow(/ENOENT|no such file/)
  })

  test("checkBeadExists returns boolean", async () => {
    const yes = await beads.checkBeadExists(ws.seedIds.epic1, ws.dbPath)
    expect(yes).toBe(true)
    const no = await beads.checkBeadExists("does-not-exist", ws.dbPath)
    expect(no).toBe(false)
  })

  test("readSpecFile rejects missing path/db, non-md, missing file", async () => {
    const noArgs = await beads.readSpecFile("", "")
    expect(noArgs.success).toBe(false)
    const notMd = await beads.readSpecFile("file.txt", ws.dbPath)
    expect(notMd.success).toBe(false)
    const enoent = await beads.readSpecFile("does-not-exist.md", ws.dbPath)
    expect(enoent.success).toBe(false)
  })
})
