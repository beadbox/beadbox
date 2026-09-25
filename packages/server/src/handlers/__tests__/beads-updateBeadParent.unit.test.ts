// Dedicated tests for the bb-ijuq guard ported into bb-qyxr —
// updateBeadParent's defense-in-depth normalization of bd's "already
// exists" duplicate-dependency error to a soft success with
// alreadyLinked: true.
//
// Why mocked: bd 1.0.x is idempotent on `bd update --parent` for an
// already-set edge (no error raised), so a real-fixture test can't
// exercise the catch branch. The original main-branch commit (977f8fd,
// bb-ijuq) used a vi.mock pattern for the same reason — the guard is
// forward-compatible defense for a bd version (or a different write
// path like bd dep add) that does throw "dependency X -> Y already
// exists". This file mocks ../lib/bd at the module boundary so the
// handler closes over an updateParent that throws on demand.

import { afterAll, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Replace the lib/bd import surface with mock-controlled versions. Only
// updateParent is exercised by these tests; everything else is a no-op
// stub that throws to surface accidental usage. Mock is hoisted before
// the handler import so handlers/beads closes over the mocked symbols.
let nextUpdateParentBehavior: () => void = () => {}

mock.module("../../lib/bd", () => {
  const stub = (name: string) => () => {
    throw new Error(`mock stub ${name} called unexpectedly`)
  }
  return {
    // The one symbol these tests exercise.
    updateParent: async () => {
      nextUpdateParentBehavior()
    },
    // Everything else handlers/beads imports from ../lib/bd — kept as
    // throw-on-call stubs so an unintentional caller fails loudly
    // instead of silently succeeding with undefined.
    addComment: stub("addComment"),
    addLabel: stub("addLabel"),
    closeBead: stub("closeBead"),
    deleteBead: stub("deleteBead"),
    deleteComment: stub("deleteComment"),
    getCustomStatuses: stub("getCustomStatuses"),
    getAvailableTypes: stub("getAvailableTypes"),
    removeDependency: stub("removeDependency"),
    removeLabel: stub("removeLabel"),
    // beadbox-xl8: re-export setCustomStatuses to match the lib/bd surface
    // beads.ts imports. Per project_bun_mock_module_global memory, bun's
    // mock.module is process-global — a missing factory entry breaks
    // import resolution everywhere, not just inside the mocked consumer.
    setCustomStatuses: stub("setCustomStatuses"),
    showBead: stub("showBead"),
    updateAssignee: stub("updateAssignee"),
    updateDefer: stub("updateDefer"),
    updateDesign: stub("updateDesign"),
    updateDue: stub("updateDue"),
    updateEstimate: stub("updateEstimate"),
    updatePriority: stub("updatePriority"),
    updateSpecId: stub("updateSpecId"),
    updateStatus: stub("updateStatus"),
    updateTitle: stub("updateTitle"),
    updateTextField: stub("updateTextField"),
    updateType: stub("updateType"),
    unmapPriority: (p: string) => p,
  }
})

const { updateBeadParent } = await import("../beads")
const workspace = mkdtempSync(join(tmpdir(), "beadbox-parent-unit-"))
const dbPath = join(workspace, ".beads")
mkdirSync(dbPath)
afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe("updateBeadParent — bb-ijuq guard (bb-qyxr port)", () => {
  test("happy path: bd succeeds → { success: true }, no alreadyLinked flag", async () => {
    nextUpdateParentBehavior = () => {}
    const result = await updateBeadParent("bb-5", "bb-epic", dbPath)
    expect(result.success).toBe(true)
    expect(result.alreadyLinked).toBeUndefined()
    expect(result.error).toBeUndefined()
  })

  test("bd throws 'already exists' → normalized to { success: true, alreadyLinked: true }", async () => {
    nextUpdateParentBehavior = () => {
      throw new Error("dependency bb-5 -> bb-epic already exists")
    }
    const result = await updateBeadParent("bb-5", "bb-epic", dbPath)
    expect(result.success).toBe(true)
    expect(result.alreadyLinked).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test("forgiving regex: case-insensitive match on 'ALREADY EXISTS' / 'Already Exists'", async () => {
    nextUpdateParentBehavior = () => {
      throw new Error("ALREADY EXISTS")
    }
    let result = await updateBeadParent("bb-5", "bb-epic", dbPath)
    expect(result).toEqual({ success: true, alreadyLinked: true })

    nextUpdateParentBehavior = () => {
      throw new Error("Already Exists")
    }
    result = await updateBeadParent("bb-5", "bb-epic", dbPath)
    expect(result).toEqual({ success: true, alreadyLinked: true })
  })

  test("non-duplicate errors propagate as { success: false, error }", async () => {
    nextUpdateParentBehavior = () => {
      throw new Error("bd not found")
    }
    const result = await updateBeadParent("bb-5", "bb-epic", dbPath)
    expect(result.success).toBe(false)
    expect(result.alreadyLinked).toBeUndefined()
    expect(result.error).toContain("bd not found")
  })

  test("forgiving regex doesn't match adjacent strings ('exists already' is NOT a duplicate marker)", async () => {
    // Pin the regex direction — bd's contract is "X already exists",
    // not "X exists already". A future maintainer widening to
    // /exists/i would silently swallow real errors that mention the
    // word in any context.
    nextUpdateParentBehavior = () => {
      throw new Error("the file exists already so we skipped it")
    }
    const result = await updateBeadParent("bb-5", "bb-epic", dbPath)
    // "exists already" matches /already/ AND /exists/ but the actual
    // regex is /already exists/i which requires the two words adjacent.
    // This input does NOT contain "already exists" as a substring, so
    // it should be treated as a non-duplicate error.
    expect(result.success).toBe(false)
    expect(result.error).toContain("exists already")
  })

  test("works with parentId === null (clear-parent path) too", async () => {
    nextUpdateParentBehavior = () => {
      throw new Error("dependency bb-5 -> null already exists")
    }
    const result = await updateBeadParent("bb-5", null, dbPath)
    expect(result).toEqual({ success: true, alreadyLinked: true })
  })

  test("works without dbPath (in-cwd workspace)", async () => {
    nextUpdateParentBehavior = () => {}
    const result = await updateBeadParent("bb-5", "bb-epic")
    expect(result.success).toBe(true)
  })
})
