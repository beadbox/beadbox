// Unit tests for handlers/epics.ts. Each handler is exercised against an
// isolated tmpdir bd workspace seeded by ./fixtures/bd-workspace.ts.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import * as epics from "../handlers/epics"
import { createBdWorkspace, runBdInWorkspace, type Workspace } from "./fixtures/bd-workspace"

setDefaultTimeout(30_000)

let ws: Workspace

beforeAll(async () => {
  ws = await createBdWorkspace()
})

afterAll(async () => {
  await ws?.cleanup()
})

describe("handlers/epics", () => {
  test("getEpics returns success: true with epic tree", async () => {
    const r = await epics.getEpics(ws.dbPath)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(Array.isArray(r.epics)).toBe(true)
      // Seed has one explicit epic; orphan logic may add a synthetic _standalone
      // epic, so just assert the named epic is present.
      const realEpic = r.epics.find((e) => e.id === ws.seedIds.epic1)
      expect(realEpic).toBeDefined()
      expect(realEpic!.children.length).toBeGreaterThanOrEqual(1)
    }
  })

  test("incrementalRefresh returns EpicResult success on fresh + cached path", async () => {
    const fresh = await epics.incrementalRefresh(ws.dbPath)
    expect(fresh.success).toBe(true)
    // Second call hits cache fast-path
    const cached = await epics.incrementalRefresh(ws.dbPath)
    expect(cached.success).toBe(true)
  })

  test("getBlocksDependencies returns blockedBy, and says so when it could not compute it", async () => {
    const r = await epics.getBlocksDependencies(ws.dbPath)
    expect(typeof r.blockedBy).toBe("object")
    expect(r.blockedBy).not.toBeNull()
    // Either computed (no degraded marker) or explicitly degraded with a reason --
    // never an empty map standing in for a failure (beadbox-01f.6).
    if (r.degraded) expect(["unsupported", "error"]).toContain(r.degraded.reason)
  })

  test("getBeadDetail returns Bead | null", async () => {
    const found = await epics.getBeadDetail(ws.seedIds.test1, ws.dbPath)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(ws.seedIds.test1)

    const missing = await epics.getBeadDetail("does-not-exist", ws.dbPath)
    expect(missing).toBeNull()
  })

  test("getCacheStats returns the documented shape", async () => {
    const r = await epics.getCacheStats()
    expect(typeof r.epicCached).toBe("boolean")
    expect(r.epicDbPath === null || typeof r.epicDbPath === "string").toBe(true)
    expect(typeof r.beadDetailCache).toBe("object")
    expect(typeof r.beadDetailCache.size).toBe("number")
    expect(Array.isArray(r.beadDetailCache.entries)).toBe(true)
  })

  test("getBeadComments returns Comment[]", async () => {
    const r = await epics.getBeadComments(ws.seedIds.test1, ws.dbPath)
    expect(Array.isArray(r)).toBe(true)
  })

  test("prefetchEpicData resolves void", async () => {
    const r = await epics.prefetchEpicData(ws.dbPath)
    expect(r).toBeUndefined()
  })
})

// beadbox-fti: regression guard for the showBeads-redundancy fix.
//
// Before this fix, handlers/epics.ts:131-149 fetched the FULL shape of
// every non-epic parent bead via `showBeads(parentBeadIds, ...)` just
// to extract `parent.dependents.filter(parent-child)`. That call was 84%
// of incrementalRefresh's budget on the hover workspace (~3.7s of a 4.4s
// total) — and empirically redundant: `childrenFromParentField`,
// built from `bead.parent` on listBeads, contains exactly the same
// data.
//
// This test pins the invariant: a workspace where test1 is reparented
// under epic1 AND test2 is reparented under test1 (making test1 a
// non-epic parent bead with one child via bead.parent) should still
// produce a tree where test2 is nested under test1 — WITHOUT the
// handler making a `bd show` round-trip for test1.
//
// A regression that re-introduces a per-parent fetch path can be caught
// at the perf-probe level (scripts/hover-perf-probe.ts), but this test
// is the unit-level backstop for the correctness invariant.
describe("handlers/epics — non-epic parent's children via bead.parent (beadbox-fti)", () => {
  let ws2: Workspace

  beforeAll(async () => {
    ws2 = await createBdWorkspace()
    // Make test1 a non-epic parent: reparent test2 under test1.
    // (test1 is already under epic1 by the default fixture setup.)
    await runBdInWorkspace(["update", ws2.seedIds.test2, "--parent", ws2.seedIds.test1], ws2.root)
  })

  afterAll(async () => {
    await ws2?.cleanup()
  })

  test("non-epic parent's children are derived from bead.parent index", async () => {
    const r = await epics.getEpics(ws2.dbPath)
    expect(r.success).toBe(true)
    if (!r.success) return

    // epic1 exists in the tree
    const epic1 = r.epics.find((e) => e.id === ws2.seedIds.epic1)
    expect(epic1).toBeDefined()

    // test1 is nested under epic1 (existing seed behavior)
    const test1Node = epic1!.children.find((c) => c.id === ws2.seedIds.test1)
    expect(test1Node).toBeDefined()

    // The invariant: test1 (a non-epic parent) has test2 as its child,
    // derived from the parent-field index (not from a bd-show round-trip).
    expect(test1Node!.children).toBeDefined()
    const test2UnderTest1 = test1Node!.children!.find((c) => c.id === ws2.seedIds.test2)
    expect(test2UnderTest1).toBeDefined()
  })

  test("incrementalRefresh produces the same nested structure (cache + fresh paths)", async () => {
    const fresh = await epics.incrementalRefresh(ws2.dbPath)
    expect(fresh.success).toBe(true)
    if (!fresh.success) return

    const epic1 = fresh.epics.find((e) => e.id === ws2.seedIds.epic1)
    const test1Node = epic1?.children.find((c) => c.id === ws2.seedIds.test1)
    expect(test1Node?.children?.find((c) => c.id === ws2.seedIds.test2)).toBeDefined()

    // Cached call should produce the same shape
    const cached = await epics.incrementalRefresh(ws2.dbPath)
    expect(cached.success).toBe(true)
    if (!cached.success) return
    const cachedTest1 = cached.epics
      .find((e) => e.id === ws2.seedIds.epic1)
      ?.children.find((c) => c.id === ws2.seedIds.test1)
    expect(cachedTest1?.children?.find((c) => c.id === ws2.seedIds.test2)).toBeDefined()
  })
})
