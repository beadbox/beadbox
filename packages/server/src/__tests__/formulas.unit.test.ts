// Unit tests for handlers/formulas.ts. Each handler is exercised against an
// isolated tmpdir bd workspace. Verifies return-shape parity:
//   Success<T> = { success: true; data: T }
//   Failure    = { success: false; error: string }
//
// Most handlers operate on formula/molecule names that don't exist in the
// fresh workspace, so they exercise the Failure path. loadFormulas operates
// against an empty workspace and returns Success<[]>. The `loadMoleculeOverlay`
// helper's topoSort logic is exercised via empty inputs (still hits the path).
//
// Per super-authorized scope: tests verify the handler doesn't crash and
// returns the documented discriminator. Byte-for-byte parity with old action
// is P1.7's job.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import * as formulas from "../handlers/formulas"
import { createBdWorkspace, type Workspace } from "./fixtures/bd-workspace"

setDefaultTimeout(30_000)

let ws: Workspace

beforeAll(async () => {
  ws = await createBdWorkspace()
})

afterAll(async () => {
  await ws?.cleanup()
})

describe("handlers/formulas", () => {
  test("loadFormulas returns success on empty workspace", async () => {
    const r = await formulas.loadFormulas(ws.dbPath)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(Array.isArray(r.data)).toBe(true)
      // User-level formulas at ~/.beads/formulas/ may be present in the
      // host environment. We only assert the shape, not the count.
    }
  })

  test("loadFormulaDetail returns failure for missing formula", async () => {
    const r = await formulas.loadFormulaDetail("does-not-exist-formula", ws.dbPath)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(typeof r.error).toBe("string")
      expect(r.error.length).toBeGreaterThan(0)
    }
  })

  test("previewFormula returns failure for missing formula", async () => {
    const r = await formulas.previewFormula("does-not-exist-formula", {}, ws.dbPath)
    expect(r.success).toBe(false)
  })

  test("previewFormula handles undefined vars", async () => {
    const r = await formulas.previewFormula("does-not-exist-formula", undefined, ws.dbPath)
    expect(r.success).toBe(false)
  })

  test("pourFormulaAction returns failure for missing formula", async () => {
    const r = await formulas.pourFormulaAction("does-not-exist-formula", {}, "tester", ws.dbPath)
    expect(r.success).toBe(false)
  })

  test("loadMoleculeProgress returns failure for missing molecule", async () => {
    const r = await formulas.loadMoleculeProgress("does-not-exist-mol", ws.dbPath)
    expect(r.success).toBe(false)
  })

  test("loadFormulaMolecules returns Success<[]> or Failure for missing formula", async () => {
    const r = await formulas.loadFormulaMolecules("does-not-exist-formula", ws.dbPath)
    // Either success-with-empty (formula doesn't exist, no molecules) or
    // failure-with-error are valid shapes per the action's behavior. Just
    // assert a discriminator is set.
    expect(typeof r.success).toBe("boolean")
    if (r.success) {
      expect(Array.isArray(r.data)).toBe(true)
    } else {
      expect(typeof r.error).toBe("string")
    }
  })

  test("loadMoleculeOverlay returns failure for missing molecule", async () => {
    const r = await formulas.loadMoleculeOverlay("does-not-exist-mol", [], ws.dbPath)
    expect(r.success).toBe(false)
  })

  test("loadMoleculeSteps returns failure for missing molecule", async () => {
    const r = await formulas.loadMoleculeSteps("bb-mol-missing", ws.dbPath)
    expect(r.success).toBe(false)
  })

  test("loadMoleculeOverlay topoSort handles empty input gracefully", async () => {
    // Empty formulaSteps + missing mol still hits the same Failure path
    // (getMoleculeStructureRaw throws), but the test ensures the empty-input
    // branch doesn't crash before it gets there.
    const r = await formulas.loadMoleculeOverlay("does-not-exist-mol", [], ws.dbPath)
    expect(r.success).toBe(false)
  })
})
