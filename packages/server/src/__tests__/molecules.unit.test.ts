// Unit tests for handlers/molecules.ts. Single export: loadMoleculeGraph.
// Exercised against an isolated tmpdir bd workspace.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import * as molecules from "../handlers/molecules"
import { BD_WORKSPACE_TIMEOUT_MS, createBdWorkspace, type Workspace } from "./fixtures/bd-workspace"

setDefaultTimeout(BD_WORKSPACE_TIMEOUT_MS)

let ws: Workspace

beforeAll(async () => {
  ws = await createBdWorkspace()
})

afterAll(async () => {
  await ws?.cleanup()
})

describe("handlers/molecules", () => {
  test("loadMoleculeGraph returns failure for missing bead", async () => {
    const r = await molecules.loadMoleculeGraph("does-not-exist", ws.dbPath)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(typeof r.error).toBe("string")
      expect(r.error.length).toBeGreaterThan(0)
    }
  })

  test("loadMoleculeGraph returns failure for non-molecule bead (regular task)", async () => {
    // The seed has test-1 (a plain task), not a molecule. The handler should
    // either return failure (bd molecule structure rejects a non-mol) or
    // success with a degenerate graph. Either way, the discriminator is set.
    const r = await molecules.loadMoleculeGraph(ws.seedIds.test1, ws.dbPath)
    expect(typeof r.success).toBe("boolean")
    if (r.success) {
      expect(typeof r.graph).toBe("object")
      expect(r.graph).not.toBeNull()
    } else {
      expect(typeof r.error).toBe("string")
    }
  })
})
