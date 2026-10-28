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
