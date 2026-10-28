// beadbox-e04o.3: the plan's order for a nested molecule, used by the Beads
// view (computeStepGroups) and by the keyboard walk (use-epic-navigation), so
// j/k visits what is drawn.
//
// bd 1.3.1 pours a step's own needs as a blocks edge between step epics
// (step.blockedBy) and a child's cross-step needs as a blocks edge between the
// children only (child.blockedBy names another step's child). Steps order by
// both: their own edges, plus "A before B" when a child of B needs a child of
// A. Own edges win: a children's edge that contradicts them (B already comes
// before A through own edges) is dropped. Children order by their needs inside
// the step only, as the Formulas tab's orderChildren does. A need on anything
// outside the molecule orders nothing. Ties keep pour order; members of a
// cycle keep pour order and go last; nothing here loops.

import type { Bead, Epic } from "./types"

export interface OrderedStep {
  step: Epic
  children: Bead[]
}

export function orderMoleculeSteps(steps: Epic[]): OrderedStep[] {
  return stableTopo(steps, stepNeeds(steps)).map((step) => ({
    step,
    children: stableTopo(step.children ?? [], childNeeds(step.children ?? [])),
  }))
}

function stepNeeds(steps: Epic[]): Map<string, Set<string>> {
  const stepIds = new Set(steps.map((s) => s.id))
  const stepOf = new Map<string, string>()
  for (const s of steps) for (const c of s.children ?? []) stepOf.set(c.id, s.id)

  const own = new Map(steps.map((s) => [s.id, new Set(ids(s).filter((n) => stepIds.has(n) && n !== s.id))]))
  const needs = new Map([...own].map(([id, set]) => [id, new Set(set)]))
  for (const s of steps) {
    for (const child of s.children ?? []) {
      for (const need of ids(child)) {
        const from = stepOf.get(need)
        if (!from || from === s.id) continue
        // "from before s" unless own edges already put s before from.
        if (!reaches(own, from, s.id)) needs.get(s.id)?.add(from)
      }
    }
  }
  return needs
}

function childNeeds(children: Bead[]): Map<string, Set<string>> {
  const inStep = new Set(children.map((c) => c.id))
  return new Map(children.map((c) => [c.id, new Set(ids(c).filter((n) => inStep.has(n) && n !== c.id))]))
}

// Does `start` need `target`, directly or through other needs? (start comes after target)
function reaches(needs: Map<string, Set<string>>, start: string, target: string): boolean {
  const seen = new Set<string>()
  const stack = [...(needs.get(start) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(needs.get(id) ?? []))
  }
  return false
}

// Repeatedly take the first item, in pour order, whose needs are all placed.
// What is left when nothing can be placed sits on or behind a cycle: it keeps
// pour order and goes last.
function stableTopo<T extends { id: string }>(items: T[], needs: Map<string, Set<string>>): T[] {
  const pending = new Map([...needs].map(([id, set]) => [id, new Set(set)]))
  const placed: T[] = []
  let progressed = true
  while (progressed) {
    progressed = false
    for (const item of items) {
      const left = pending.get(item.id)
      if (!left || left.size > 0) continue
      placed.push(item)
      pending.delete(item.id)
      for (const rest of pending.values()) rest.delete(item.id)
      progressed = true
      break
    }
  }
  return [...placed, ...items.filter((i) => pending.has(i.id))]
}

const ids = (bead: Bead) => (bead.blockedBy ?? []).map((d) => d.id)
