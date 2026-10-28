// Synthetic formulas for the Formulas tab graph tests (beadbox-ptca.2). The
// nested one has the shape bd formula show emits for a formula whose steps
// hold children: the steps carry no needs, and every need sits on a child,
// some crossing into another step.

import type { Edge, Node } from "@xyflow/react"
import type { FormulaStep } from "../lib/types"

const task = (id: string, needs?: string[]): FormulaStep => ({
  id,
  title: `Task ${id}`,
  type: "task",
  ...(needs ? { needs } : {}),
})

const step = (id: string, children?: FormulaStep[]): FormulaStep => ({
  id,
  title: `Step ${id}`,
  type: "epic",
  ...(children ? { children } : {}),
})

// 6 steps of 2-8 children. Each step lists its children out of dependency
// order, so a layout that keeps formula order inside a step is caught.
// Cross-step needs: s2.a needs s1.b, s4.a needs s3.c and s2.h, s6.c needs s5.d.
export function nestedFormula(): FormulaStep[] {
  return [
    step("s1", [task("s1.b", ["s1.a"]), task("s1.a")]),
    step("s2", [
      task("s2.h", ["s2.g"]),
      task("s2.g", ["s2.f"]),
      task("s2.f", ["s2.e"]),
      task("s2.e", ["s2.d"]),
      task("s2.d", ["s2.c"]),
      task("s2.c", ["s2.b"]),
      task("s2.b", ["s2.a"]),
      task("s2.a", ["s1.b"]),
    ]),
    step("s3", [task("s3.c", ["s3.a", "s3.b"]), task("s3.a"), task("s3.b")]),
    step("s4", [
      task("s4.e", ["s4.d"]),
      task("s4.a", ["s3.c", "s2.h"]),
      task("s4.d", ["s4.b", "s4.c"]),
      task("s4.b", ["s4.a"]),
      task("s4.c", ["s4.a"]),
    ]),
    step("s5", [
      task("s5.d", ["s5.c"]),
      task("s5.c", ["s5.b"]),
      task("s5.b", ["s5.a"]),
      task("s5.a"),
    ]),
    step("s6", [
      task("s6.f", ["s6.e"]),
      task("s6.e", ["s6.d"]),
      task("s6.d", ["s6.c"]),
      task("s6.c", ["s5.d", "s6.b"]),
      task("s6.b", ["s6.a"]),
      task("s6.a"),
    ]),
  ]
}

// The dependency order each step's children must come out in.
export const NESTED_CHILD_ORDER: Record<string, string[]> = {
  s1: ["s1.a", "s1.b"],
  s2: ["s2.a", "s2.b", "s2.c", "s2.d", "s2.e", "s2.f", "s2.g", "s2.h"],
  s3: ["s3.a", "s3.b", "s3.c"],
  s4: ["s4.a", "s4.b", "s4.c", "s4.d", "s4.e"],
  s5: ["s5.a", "s5.b", "s5.c", "s5.d"],
  s6: ["s6.a", "s6.b", "s6.c", "s6.d", "s6.e", "s6.f"],
}

// The step edges the nested formula's cross-step needs give (beadbox-ptca.3):
// s2.a needs s1.b; s4.a needs s3.c and s2.h; s6.c needs s5.d.
export const NESTED_STEP_EDGES = ["s1->s2", "s2->s4", "s3->s4", "s5->s6"]

// A flat formula as today: step-level needs, a sequential chain, a gate.
export function flatFormula(): FormulaStep[] {
  return [
    { id: "design", title: "Design", type: "task" },
    { id: "build", title: "Build", type: "task", needs: ["design"] },
    { id: "test", title: "Test", type: "task", needs: ["build"] },
    { id: "approve", title: "Approve", type: "task", needs: ["test"], gate: { type: "human" } },
    { id: "docs", title: "Docs", type: "task", needs: ["design"] },
    { id: "ship", title: "Ship", type: "task", needs: ["approve", "docs"] },
  ]
}

// A real parallel set: three steps with identical needs and dependents.
export function parallelFormula(): FormulaStep[] {
  return [
    { id: "prep", title: "Prep", type: "task" },
    { id: "lint", title: "Lint", type: "task", needs: ["prep"] },
    { id: "unit", title: "Unit", type: "task", needs: ["prep"] },
    { id: "e2e", title: "E2E", type: "task", needs: ["prep"] },
    { id: "merge", title: "Merge", type: "task", needs: ["lint", "unit", "e2e"] },
  ]
}

// The parts of a layout that make it "the same layout": node ids, kinds,
// positions and group membership, and the drawn edges.
export function layoutShape({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  return {
    nodes: nodes.map((n) => {
      const data = n.data as { step?: FormulaStep; group?: { steps: FormulaStep[] } }
      return {
        id: n.id,
        type: n.type,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
        members: data.group ? data.group.steps.map((s) => s.id) : data.step ? [data.step.id] : [],
      }
    }),
    edges: edges.map((e) => `${e.source}->${e.target}`),
  }
}
