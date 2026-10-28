// beadbox-ptca.2: a nested formula (bd formula show with `children` on its
// steps) is drawn as one container per step. These helpers decide that and
// order a step's children for display.

import type { FormulaStep } from "./types"

export function isNestedFormula(steps: FormulaStep[]): boolean {
  return steps.some((s) => (s.children?.length ?? 0) > 0)
}

// Stable topological order of one step's children by their needs, ties in
// formula order. A need on a bead outside the step does not order anything
// here (it is a cross-step edge). Children caught in a cycle are appended in
// formula order and named in `cyclic`, so a bad formula still renders.
export function orderChildren(children: FormulaStep[]): {
  ordered: FormulaStep[]
  cyclic: string[]
} {
  const inStep = new Set(children.map((c) => c.id))
  const pending = new Map(
    children.map((c) => [
      c.id,
      new Set((c.needs ?? []).filter((n) => inStep.has(n) && n !== c.id)),
    ]),
  )
  const ordered: FormulaStep[] = []
  let progressed = true
  while (progressed) {
    progressed = false
    for (const c of children) {
      const needs = pending.get(c.id)
      if (!needs || needs.size > 0) continue
      ordered.push(c)
      pending.delete(c.id)
      for (const rest of pending.values()) rest.delete(c.id)
      progressed = true
      break
    }
  }
  const cyclic = children.filter((c) => pending.has(c.id))
  return { ordered: [...ordered, ...cyclic], cyclic: cyclic.map((c) => c.id) }
}

// Edges between the steps of a nested formula (beadbox-ptca.3): "A->B" when a
// child of B (or B itself) needs a child of A (or A itself), once per pair,
// in formula order. A need on nothing in the formula, or within the same
// step, draws no edge. `cyclic` names the steps that sit on a cycle (a step
// that only follows or sits between cycles is not named); finding them never
// loops.
export function stepEdges(steps: FormulaStep[]): { edges: string[]; cyclic: string[] } {
  const stepOf = new Map<string, string>()
  for (const s of steps) {
    stepOf.set(s.id, s.id)
    for (const c of s.children ?? []) stepOf.set(c.id, s.id)
  }
  const edges = new Set<string>()
  for (const s of steps) {
    for (const node of [s, ...(s.children ?? [])]) {
      for (const need of node.needs ?? []) {
        const from = stepOf.get(need)
        if (from && from !== s.id) edges.add(`${from}->${s.id}`)
      }
    }
  }
  const pairs = [...edges].map((e) => e.split("->") as [string, string])
  return { edges: [...edges], cyclic: stepsOnCycles(steps, pairs) }
}

// A step is on a cycle when it can reach itself. A visited set bounds each
// walk, and formulas have tens of steps, so one walk per step is cheap.
function stepsOnCycles(steps: FormulaStep[], pairs: [string, string][]): string[] {
  const next = new Map<string, string[]>()
  for (const [a, b] of pairs) next.set(a, [...(next.get(a) ?? []), b])
  const reachesItself = (start: string) => {
    const seen = new Set<string>()
    const stack = [...(next.get(start) ?? [])]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (id === start) return true
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...(next.get(id) ?? []))
    }
    return false
  }
  return steps.filter((s) => reachesItself(s.id)).map((s) => s.id)
}
