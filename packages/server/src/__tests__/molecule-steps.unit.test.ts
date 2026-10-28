// beadbox-ptca.1: the molecule read gives the Formulas tab graph each step
// with its children and their needs. Fixtures are synthetic `bd mol show
// --json` documents in the shape bd 1.3 emits for a poured nested formula:
// root -> step epics -> child tasks through parent-child deps, and every
// cross-bead need as a `blocks` dep (issue_id is blocked by depends_on_id).
//
// Each fixture is written as the expected output first; molShow() turns it
// into the raw document, with issues and deps in a scrambled order the way
// bd returns them.

import { describe, expect, test } from "bun:test"
import type { MolShowRaw } from "../lib/bd"
import { buildMoleculeSteps } from "../lib/molecule-steps"
import type { MoleculeStep } from "../lib/types"

const ROOT = "syn-mol-root"
const STATUSES = ["open", "in_progress", "closed", "blocked"]

function molShow(steps: MoleculeStep[], extraDeps: MolShowRaw["dependencies"] = []): MolShowRaw {
  const issues: MolShowRaw["issues"] = [
    {
      id: ROOT,
      title: "synthetic",
      status: "open",
      issue_type: "molecule",
      updated_at: "2026-10-28T00:00:00Z",
    },
  ]
  const deps: MolShowRaw["dependencies"] = []
  const add = (n: MoleculeStep["children"][number], parent: string) => {
    issues.push({
      id: n.id,
      title: n.title,
      status: n.status,
      issue_type: n.type,
      updated_at: "2026-10-28T00:00:00Z",
    })
    deps.push({ issue_id: n.id, depends_on_id: parent, type: "parent-child" })
    for (const need of n.needs) deps.push({ issue_id: n.id, depends_on_id: need, type: "blocks" })
  }
  for (const s of steps) {
    add(s, ROOT)
    for (const c of s.children) add(c, s.id)
  }
  // bd's order is not the formula's: reverse both lists so a builder that
  // leans on input adjacency fails.
  return {
    root: { id: ROOT, title: "synthetic", status: "open" },
    issues: issues.reverse(),
    dependencies: [...deps, ...extraDeps].reverse(),
  }
}

// 6 steps of 2-8 children. Inside a step each child needs the one before it;
// each step's first child needs the previous step's last child (a cross-step
// need), and the last step's third child also needs a child two steps back.
function nestedSpec(): MoleculeStep[] {
  const counts = [2, 8, 3, 5, 4, 6]
  let n = 0
  const steps: MoleculeStep[] = counts.map((count, si) => ({
    id: `syn-mol-s${si}`,
    title: `Step ${si}`,
    type: "epic",
    status: STATUSES[si % STATUSES.length],
    needs: [],
    children: Array.from({ length: count }, (_, ci) => ({
      id: `syn-mol-s${si}c${ci}`,
      title: `Step ${si} child ${ci}`,
      type: "task",
      status: STATUSES[n++ % STATUSES.length],
      needs: ci > 0 ? [`syn-mol-s${si}c${ci - 1}`] : [],
    })),
  }))
  for (let si = 1; si < steps.length; si++) {
    const prev = steps[si - 1].children
    steps[si].children[0].needs.push(prev[prev.length - 1].id)
  }
  steps[5].children[2].needs.push("syn-mol-s3c1")
  return steps
}

const byId = <T extends { id: string }>(list: T[]) =>
  [...list].sort((a, b) => a.id.localeCompare(b.id))
function normalize(steps: MoleculeStep[]) {
  return byId(steps).map((s) => ({
    ...s,
    needs: [...s.needs].sort(),
    children: byId(s.children).map((c) => ({ ...c, needs: [...c.needs].sort() })),
  }))
}

describe("buildMoleculeSteps (beadbox-ptca.1)", () => {
  test("a nested molecule lists every step with its children, statuses and needs", () => {
    const spec = nestedSpec()
    const got = buildMoleculeSteps(molShow(spec))
    expect(got).toHaveLength(6)
    expect(got.map((s) => s.children.length).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 8])
    expect(normalize(got)).toEqual(normalize(spec))
    // The cross-step needs survive, not only the in-step ones.
    const s5 = got.find((s) => s.id === "syn-mol-s5")!
    expect(s5.children.find((c) => c.id === "syn-mol-s5c0")!.needs).toContain("syn-mol-s4c3")
    expect(s5.children.find((c) => c.id === "syn-mol-s5c2")!.needs.sort()).toEqual([
      "syn-mol-s3c1",
      "syn-mol-s5c1",
    ])
    // Mixed statuses come through as bd reports them.
    expect(new Set(got.flatMap((s) => s.children.map((c) => c.status)))).toEqual(new Set(STATUSES))
  })

  test("a flat molecule gives its steps with step-level needs and no children", () => {
    const spec: MoleculeStep[] = [
      { id: "syn-mol-a", title: "A", type: "task", status: "closed", needs: [], children: [] },
      {
        id: "syn-mol-b",
        title: "B",
        type: "task",
        status: "in_progress",
        needs: ["syn-mol-a"],
        children: [],
      },
      {
        id: "syn-mol-c",
        title: "C",
        type: "task",
        status: "open",
        needs: ["syn-mol-a"],
        children: [],
      },
      {
        id: "syn-mol-d",
        title: "D",
        type: "task",
        status: "open",
        needs: ["syn-mol-b", "syn-mol-c"],
        children: [],
      },
    ]
    expect(normalize(buildMoleculeSteps(molShow(spec)))).toEqual(normalize(spec))
  })

  test("a step with zero children has children []", () => {
    const spec: MoleculeStep[] = [
      { id: "syn-mol-s0", title: "Empty", type: "epic", status: "open", needs: [], children: [] },
      {
        id: "syn-mol-s1",
        title: "Full",
        type: "epic",
        status: "open",
        needs: [],
        children: [
          { id: "syn-mol-s1c0", title: "only", type: "task", status: "closed", needs: [] },
        ],
      },
    ]
    expect(normalize(buildMoleculeSteps(molShow(spec)))).toEqual(normalize(spec))
  })

  test("a need on a bead outside the molecule is dropped, and the root is never a step or a need", () => {
    const spec = nestedSpec()
    const outside = [
      { issue_id: "syn-mol-s1c0", depends_on_id: "other-xyz", type: "blocks" },
      { issue_id: "syn-mol-s2c0", depends_on_id: ROOT, type: "blocks" },
    ]
    const got = buildMoleculeSteps(molShow(spec, outside))
    expect(normalize(got)).toEqual(normalize(spec))
    expect(got.some((s) => s.id === ROOT)).toBe(false)
  })

  test("a dependency cycle is returned as data, not looped on", () => {
    const spec: MoleculeStep[] = [
      {
        id: "syn-mol-s0",
        title: "Cycle",
        type: "epic",
        status: "open",
        needs: [],
        children: [
          { id: "syn-mol-x", title: "x", type: "task", status: "open", needs: ["syn-mol-y"] },
          { id: "syn-mol-y", title: "y", type: "task", status: "open", needs: ["syn-mol-x"] },
        ],
      },
    ]
    expect(normalize(buildMoleculeSteps(molShow(spec)))).toEqual(normalize(spec))
  })

  test("non-blocking deps (related, discovered-from) are not needs", () => {
    const spec = nestedSpec()
    const extra = [
      { issue_id: "syn-mol-s0c0", depends_on_id: "syn-mol-s1c1", type: "related" },
      { issue_id: "syn-mol-s0c1", depends_on_id: "syn-mol-s2c0", type: "discovered-from" },
    ]
    expect(normalize(buildMoleculeSteps(molShow(spec, extra)))).toEqual(normalize(spec))
  })

  test("an empty molecule gives no steps", () => {
    expect(buildMoleculeSteps(molShow([]))).toEqual([])
  })
})
