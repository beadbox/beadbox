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

  test("getBlocksDependencies returns Record (possibly empty)", async () => {
    const r = await epics.getBlocksDependencies(ws.dbPath)
    expect(typeof r).toBe("object")
    expect(r).not.toBeNull()
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

describe("handlers/epics — system issue visibility", () => {
  let gateWorkspace: Workspace
  let gateId: string

  beforeAll(async () => {
    gateWorkspace = await createBdWorkspace()
    await runBdInWorkspace(["config", "set", "types.custom", "gate"], gateWorkspace.root)
    const created = JSON.parse(
      await runBdInWorkspace(
        ["create", "Gate issue", "--type", "gate", "--json"],
        gateWorkspace.root,
      ),
    ) as { id: string }
    gateId = created.id
  })

  afterAll(async () => {
    await gateWorkspace?.cleanup()
  })

  test("normal, full, then normal view exposes only the requested issues", async () => {
    const getGate = (result: Awaited<ReturnType<typeof epics.getEpics>>) =>
      result.success
        ? result.epics.flatMap((epic) => epic.children).find((bead) => bead.id === gateId)
        : undefined

    const normal = await epics.getEpics(gateWorkspace.dbPath, false)
    expect(normal.success).toBe(true)
    expect(getGate(normal)).toBeUndefined()

    const full = await epics.getEpics(gateWorkspace.dbPath, true)
    expect(full.success).toBe(true)
    expect(getGate(full)?.type).toBe("gate")

    const normalAgain = await epics.incrementalRefresh(gateWorkspace.dbPath, false)
    expect(normalAgain.success).toBe(true)
    expect(getGate(normalAgain)).toBeUndefined()
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

describe("handlers/epics — molecule type fidelity", () => {
  let moleculeWorkspace: Workspace

  beforeAll(async () => {
    moleculeWorkspace = await createBdWorkspace()
    await runBdInWorkspace(["config", "set", "types.custom", "molecule"], moleculeWorkspace.root)
  })

  afterAll(async () => {
    await moleculeWorkspace?.cleanup()
  })

  test("full view keeps a molecule root and its child", async () => {
    const created = JSON.parse(
      await runBdInWorkspace(
        ["create", "Molecule root", "--type", "molecule", "--json"],
        moleculeWorkspace.root,
      ),
    ) as { id: string }
    await runBdInWorkspace(
      ["update", moleculeWorkspace.seedIds.test2, "--parent", created.id],
      moleculeWorkspace.root,
    )

    const result = await epics.getEpics(moleculeWorkspace.dbPath, true)
    expect(result.success).toBe(true)
    if (!result.success) return
    const root = result.epics.find((epic) => epic.id === created.id)
    expect(root?.type).toBe("molecule")
    expect(root?.children.map((child) => child.id)).toContain(moleculeWorkspace.seedIds.test2)
  })
})

describe("handlers/epics — milestone hierarchy", () => {
  let milestoneWorkspace: Workspace

  beforeAll(async () => {
    milestoneWorkspace = await createBdWorkspace()
  })

  afterAll(async () => {
    await milestoneWorkspace?.cleanup()
  })

  test("milestone contains its epic and task once; an empty milestone remains a root", async () => {
    const milestone = JSON.parse(
      await runBdInWorkspace(
        ["create", "Milestone parent", "--type", "milestone", "--json"],
        milestoneWorkspace.root,
      ),
    ) as { id: string }
    const emptyMilestone = JSON.parse(
      await runBdInWorkspace(
        ["create", "Empty milestone", "--type", "milestone", "--json"],
        milestoneWorkspace.root,
      ),
    ) as { id: string }
    await runBdInWorkspace(
      ["update", milestoneWorkspace.seedIds.epic1, "--parent", milestone.id],
      milestoneWorkspace.root,
    )

    const result = await epics.getEpics(milestoneWorkspace.dbPath)
    expect(result.success).toBe(true)
    if (!result.success) return

    const root = result.epics.find((epic) => epic.id === milestone.id)
    const nestedEpic = root?.childEpics?.find(
      (epic) => epic.id === milestoneWorkspace.seedIds.epic1,
    )
    expect(root?.type).toBe("milestone")
    expect(nestedEpic?.type).toBe("epic")
    expect(nestedEpic?.children.map((bead) => bead.id)).toContain(milestoneWorkspace.seedIds.test1)
    expect(result.epics.find((epic) => epic.id === emptyMilestone.id)).toMatchObject({
      type: "milestone",
      children: [],
      childEpics: [],
    })

    type TreeNode = { id: string; children?: TreeNode[]; childEpics?: TreeNode[] }
    const allIds = result.epics.flatMap(function visit(node: TreeNode): string[] {
      return [
        node.id,
        ...(node.children ?? []).flatMap(visit),
        ...(node.childEpics ?? []).flatMap(visit),
      ]
    })
    for (const id of [
      milestone.id,
      emptyMilestone.id,
      milestoneWorkspace.seedIds.epic1,
      milestoneWorkspace.seedIds.test1,
    ]) {
      expect(allIds.filter((seen) => seen === id)).toHaveLength(1)
    }
  })
})

describe("handlers/epics — epic below a non-epic parent", () => {
  let nestedWorkspace: Workspace

  beforeAll(async () => {
    nestedWorkspace = await createBdWorkspace()
  })

  afterAll(async () => {
    await nestedWorkspace?.cleanup()
  })

  test("decision → epic → nested epic → task appears once at every level", async () => {
    const decision = JSON.parse(
      await runBdInWorkspace(
        ["create", "Decision parent", "--type", "decision", "--json"],
        nestedWorkspace.root,
      ),
    ) as { id: string }
    const nestedEpic = JSON.parse(
      await runBdInWorkspace(
        ["create", "Nested epic", "--type", "epic", "--json"],
        nestedWorkspace.root,
      ),
    ) as { id: string }
    await runBdInWorkspace(
      ["update", nestedWorkspace.seedIds.epic1, "--parent", decision.id],
      nestedWorkspace.root,
    )
    await runBdInWorkspace(
      ["update", nestedEpic.id, "--parent", nestedWorkspace.seedIds.epic1],
      nestedWorkspace.root,
    )
    await runBdInWorkspace(
      ["update", nestedWorkspace.seedIds.test1, "--parent", nestedEpic.id],
      nestedWorkspace.root,
    )

    const result = await epics.getEpics(nestedWorkspace.dbPath)
    expect(result.success).toBe(true)
    if (!result.success) return

    const standalone = result.epics.find((epic) => epic.id === "_standalone")
    const decisionNode = standalone?.children.find((bead) => bead.id === decision.id)
    const epicNode = decisionNode?.children?.find(
      (bead) => bead.id === nestedWorkspace.seedIds.epic1,
    )
    const nestedEpicNode = epicNode?.children?.find((bead) => bead.id === nestedEpic.id)
    expect(decisionNode?.type).toBe("decision")
    expect(epicNode?.type).toBe("epic")
    expect(nestedEpicNode?.type).toBe("epic")
    expect(nestedEpicNode?.children?.map((bead) => bead.id)).toContain(
      nestedWorkspace.seedIds.test1,
    )
    expect((epicNode as typeof standalone | undefined)?.childEpics).toHaveLength(0)

    type TreeNode = { id: string; children?: TreeNode[]; childEpics?: TreeNode[] }
    const allIds = result.epics.flatMap(function visit(node: TreeNode): string[] {
      return [
        node.id,
        ...(node.children ?? []).flatMap(visit),
        ...(node.childEpics ?? []).flatMap(visit),
      ]
    })
    for (const id of [
      decision.id,
      nestedWorkspace.seedIds.epic1,
      nestedEpic.id,
      nestedWorkspace.seedIds.test1,
    ]) {
      expect(allIds.filter((seen) => seen === id)).toHaveLength(1)
    }
  })
})
