import { describe, expect, test } from "bun:test"
import { computeMoleculePhases } from "../lib/molecule-phases"
import type { Bead } from "../lib/types"

// bb-fe03.7 regression suite for computeMoleculePhases. CCN was 26
// (5 distinct steps: gate/task split, gate-source map, gate-info map,
// predecessor resolution, topological sort + grouping). The refactor
// extracts each step; observable phase output below must hold across.

const bead = (id: string, over: Partial<Bead> = {}): Bead =>
  ({
    id,
    title: id,
    type: "task",
    status: "open",
    priority: "P2",
    blockedBy: [],
    ...over,
  }) as unknown as Bead

const dep = (id: string) => ({ id, title: id })

describe("computeMoleculePhases", () => {
  test("returns empty array for no children", () => {
    expect(computeMoleculePhases([])).toEqual([])
  })

  test("single task with no deps lands in phase 1", () => {
    const phases = computeMoleculePhases([bead("t1")])
    expect(phases).toHaveLength(1)
    expect(phases[0]?.phaseNumber).toBe(1)
    expect(phases[0]?.tasks).toHaveLength(1)
    expect(phases[0]?.tasks[0]?.id).toBe("t1")
    expect(phases[0]?.totalCount).toBe(1)
    expect(phases[0]?.closedCount).toBe(0)
  })

  test("linear chain t1 → t2 → t3 produces 3 phases", () => {
    const phases = computeMoleculePhases([
      bead("t1"),
      bead("t2", { blockedBy: [dep("t1")] }),
      bead("t3", { blockedBy: [dep("t2")] }),
    ])
    expect(phases.map((p) => p.phaseNumber)).toEqual([1, 2, 3])
    expect(phases[0]?.tasks[0]?.id).toBe("t1")
    expect(phases[1]?.tasks[0]?.id).toBe("t2")
    expect(phases[2]?.tasks[0]?.id).toBe("t3")
  })

  test("parallel tasks at same depth land in same phase", () => {
    const phases = computeMoleculePhases([
      bead("t1"),
      bead("t2"),
      bead("t3", { blockedBy: [dep("t1"), dep("t2")] }),
    ])
    expect(phases).toHaveLength(2)
    expect(phases[0]?.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"])
    expect(phases[1]?.tasks[0]?.id).toBe("t3")
  })

  test("closedCount + totalCount per phase", () => {
    const phases = computeMoleculePhases([
      bead("t1", { status: "closed" }),
      bead("t2"),
      bead("t3", { status: "closed", blockedBy: [dep("t1")] }),
    ])
    expect(phases[0]?.closedCount).toBe(1) // t1
    expect(phases[0]?.totalCount).toBe(2) // t1, t2
    expect(phases[1]?.closedCount).toBe(1) // t3
    expect(phases[1]?.totalCount).toBe(1)
  })

  test("gate that bridges two tasks resolves to the source task", () => {
    // t2 blocked by g1; g1 blocked by t1; → t2 should phase after t1
    const phases = computeMoleculePhases([
      bead("t1"),
      bead("g1", { type: "gate", blockedBy: [dep("t1")] } as Partial<Bead>),
      bead("t2", { blockedBy: [dep("g1")] }),
    ])
    // beadbox-wya0.2: the gate is now a row, beside the task it holds.
    expect(phases.map((p) => p.tasks.map((t) => t.id))).toEqual([["t1"], ["g1", "t2"]])
  })

  test("gate type detection: 'conditional' / 'human' / 'unknown'", () => {
    const phases = computeMoleculePhases([
      bead("t1"),
      bead("g-cond", {
        type: "gate",
        title: "Gate: conditional check",
        blockedBy: [dep("t1")],
      } as Partial<Bead>),
      bead("g-hum", {
        type: "gate",
        title: "human review",
        blockedBy: [dep("t1")],
      } as Partial<Bead>),
      bead("g-unk", {
        type: "gate",
        title: "Some gate",
        blockedBy: [dep("t1")],
      } as Partial<Bead>),
      bead("t-cond", { blockedBy: [dep("g-cond")] }),
      bead("t-hum", { blockedBy: [dep("g-hum")] }),
      bead("t-unk", { blockedBy: [dep("g-unk")] }),
    ])
    const allTasks = phases.flatMap((p) => p.tasks)
    const tCond = allTasks.find((t) => t.id === "t-cond")
    const tHum = allTasks.find((t) => t.id === "t-hum")
    const tUnk = allTasks.find((t) => t.id === "t-unk")
    expect(tCond?.gate?.type).toBe("conditional")
    expect(tHum?.gate?.type).toBe("human")
    expect(tUnk?.gate?.type).toBe("unknown")
  })

  test("orphan task with non-existent dep falls to phase 1", () => {
    const phases = computeMoleculePhases([bead("orphan", { blockedBy: [dep("missing")] })])
    expect(phases).toHaveLength(1)
    expect(phases[0]?.phaseNumber).toBe(1)
    expect(phases[0]?.tasks[0]?.id).toBe("orphan")
  })

  test("cyclic deps both fall to phase 1 (no infinite loop)", () => {
    const phases = computeMoleculePhases([
      bead("c1", { blockedBy: [dep("c2")] }),
      bead("c2", { blockedBy: [dep("c1")] }),
    ])
    expect(phases).toHaveLength(1)
    expect(phases[0]?.phaseNumber).toBe(1)
    expect(phases[0]?.tasks).toHaveLength(2)
  })

  test("preserves input order within a phase", () => {
    const phases = computeMoleculePhases([
      bead("z"),
      bead("a"),
      bead("m"),
    ])
    expect(phases[0]?.tasks.map((t) => t.id)).toEqual(["z", "a", "m"])
  })

  // beadbox-wya0.2: gates are rows in their phase, not only a badge.
  const gate = (id: string, over: Partial<Bead> = {}) =>
    bead(id, { type: "gate", title: `Gate: ${id}`, ...over } as Partial<Bead>)
  const ids = (phases: ReturnType<typeof computeMoleculePhases>) =>
    phases.map((p) => p.tasks.map((t) => t.id))

  test("a gate with only a parent-child link is a row (phase 1)", () => {
    const phases = computeMoleculePhases([bead("t1"), gate("g1")])
    expect(ids(phases)).toEqual([["t1", "g1"]])
    expect(phases[0]?.totalCount).toBe(2)
  })

  test("a gate that blocks no task sits one phase after its latest predecessor", () => {
    const phases = computeMoleculePhases([
      bead("t1"),
      bead("t2", { blockedBy: [dep("t1")] }),
      gate("g1", { blockedBy: [dep("t2")] }),
    ])
    expect(ids(phases)).toEqual([["t1"], ["t2"], ["g1"]])
  })

  test("a gate sits in the phase of the earliest task it blocks; task phases do not move", () => {
    // A formula step's gate: no deps of its own, blocks the step it guards.
    const phases = computeMoleculePhases([
      bead("build"),
      bead("review", { blockedBy: [dep("build"), dep("g-review")] }),
      gate("g-review"),
      bead("ship", { blockedBy: [dep("review")] }),
    ])
    expect(ids(phases)).toEqual([["build"], ["review", "g-review"], ["ship"]])
  })

  test("a gate row carries its own kind, status and deadline", () => {
    const phases = computeMoleculePhases([
      gate("g-h", { gateWait: { awaitType: "human" } }),
      gate("g-t", { status: "closed", gateWait: { awaitType: "timer", deadline: "2026-10-28T21:00:00.000Z" } }),
      gate("g-r", { gateWait: { awaitType: "gh:run", awaitId: "ci.yml" } }),
      gate("g-b", { gateWait: { awaitType: "bead", awaitId: "x-1" } }),
      gate("g-none", { title: "Approve release", gateWait: { awaitType: "" } }),
    ])
    const row = (id: string) => phases.flatMap((p) => p.tasks).find((t) => t.id === id)?.gate
    expect(row("g-h")).toEqual({ id: "g-h", type: "human", status: "open" })
    expect(row("g-t")).toEqual({ id: "g-t", type: "timer", status: "closed", deadline: "2026-10-28T21:00:00.000Z" })
    expect(row("g-r")?.type).toBe("gh:run")
    expect(row("g-b")?.type).toBe("bead")
    expect(row("g-none")?.type).toBe("unknown")
  })

  test("the badge on a blocked task takes bd's kind over the title", () => {
    const phases = computeMoleculePhases([
      gate("g1", { title: "Gate: human", gateWait: { awaitType: "timer" } }),
      bead("t1", { blockedBy: [dep("g1")] }),
    ])
    expect(phases.flatMap((p) => p.tasks).find((t) => t.id === "t1")?.gate?.type).toBe("timer")
  })

  test("a closed gate counts as done, so a phase of resolved gates and closed tasks is complete", () => {
    const phases = computeMoleculePhases([
      bead("t1", { status: "closed" }),
      gate("g1", { status: "closed" }),
      gate("g2"),
    ])
    expect(phases[0]?.closedCount).toBe(2)
    expect(phases[0]?.totalCount).toBe(3)
  })
})
