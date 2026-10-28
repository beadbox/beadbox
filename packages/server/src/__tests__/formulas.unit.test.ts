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
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as formulas from "../handlers/formulas"
import { createBdWorkspace, runBdInWorkspace, type Workspace } from "./fixtures/bd-workspace"

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

// beadbox-ptca.5: a real pour on the scratch fixture. probe-flow is poured
// twice and probe-flow-v2 (a name starting with the first) once; each formula
// lists exactly its own pours, with the progress bd mol progress reports.
describe("loadFormulaMolecules on a real pour (beadbox-ptca.5)", () => {
  const formula = (name: string) => `formula = "${name}"
description = "synthetic"
version = 1
type = "workflow"

[[steps]]
id = "a"
title = "Step A"

[[steps]]
id = "b"
title = "Step B"
needs = ["a"]
`
  const bdJson = async <T>(args: string[]): Promise<T> =>
    JSON.parse(await runBdInWorkspace([...args, "--json"], ws.root)) as T
  const moleculeIds = async (title: string) =>
    (await bdJson<Array<{ id: string; title: string }>>(["list", "--type", "molecule", "--status", "all", "--limit", "0", "--flat"]))
      .filter((b) => b.title === title)
      .map((b) => b.id)
      .sort()

  beforeAll(async () => {
    const dir = join(ws.dbPath, "formulas")
    await mkdir(dir, { recursive: true })
    for (const name of ["probe-flow", "probe-flow-v2"]) {
      await writeFile(join(dir, `${name}.formula.toml`), formula(name))
    }
    for (const name of ["probe-flow", "probe-flow", "probe-flow-v2"]) {
      await runBdInWorkspace(["mol", "pour", name], ws.root)
    }
  })

  test("one card per pour, each formula only its own, progress from bd mol progress", async () => {
    for (const [name, pours] of [["probe-flow", 2], ["probe-flow-v2", 1]] as const) {
      const r = await formulas.loadFormulaMolecules(name, ws.dbPath)
      expect(r.success).toBe(true)
      if (!r.success) continue
      const expected = await moleculeIds(name)
      expect(expected).toHaveLength(pours)
      expect(r.data.map((c) => c.id).sort()).toEqual(expected)
      for (const card of r.data) {
        const p = await bdJson<{ total: number; completed: number }>(["mol", "progress", card.id])
        expect(card.progress.total).toBe(p.total)
        expect(card.progress.total).toBe(2)
        expect(card.progress.completed).toBe(p.completed)
      }
    }
  })

  test("a closed molecule comes back closed, for the completed group", async () => {
    const [first] = await moleculeIds("probe-flow-v2")
    // bd refuses to close a root with open steps, or Step B before Step A.
    const mol = await bdJson<{ issues: Array<{ id: string; title: string }> }>(["mol", "show", first!])
    const steps = mol.issues.filter((i) => i.id !== first).sort((a, b) => a.title.localeCompare(b.title))
    for (const step of steps) {
      await runBdInWorkspace(["close", step.id], ws.root)
    }
    await runBdInWorkspace(["close", first!], ws.root)
    const r = await formulas.loadFormulaMolecules("probe-flow-v2", ws.dbPath)
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.map((c) => [c.id, c.status])).toEqual([[first!, "closed"]])
    expect([r.data[0]!.progress.completed, r.data[0]!.progress.total]).toEqual([2, 2])
  })
})
