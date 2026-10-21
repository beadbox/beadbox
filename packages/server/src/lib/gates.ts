// Open gates and the issues they hold, from one `bd list --include-gates`
// result. Lives outside lib/bd.ts because it never runs bd: bd.ts's exports
// are the argv surface the security census enumerates.
//
// A gate holds an issue through a "blocks" dependency on the gate. bd also
// withholds every descendant of a held issue from `bd ready` (an epic gate
// withholds its children), so descendants are listed too, tagged with the
// gated ancestor they wait through.

import type { BdBead } from "./bd"
import type { GateHeldIssue, WaitingGate } from "./types"

const DONE_STATUSES = new Set(["closed", "tombstone"])
const NS_PER_MS = 1_000_000

function isOpen(issue: BdBead): boolean {
  return !DONE_STATUSES.has(issue.status)
}

function parentOf(issue: BdBead): string | undefined {
  if (issue.parent) return issue.parent
  return issue.dependencies?.find((edge) => edge.type === "parent-child")?.depends_on_id
}

function indexIssues(issues: BdBead[]) {
  const children = new Map<string, BdBead[]>()
  const heldBy = new Map<string, BdBead[]>()
  for (const issue of issues) {
    const parent = parentOf(issue)
    if (parent) children.set(parent, [...(children.get(parent) ?? []), issue])
    for (const edge of issue.dependencies ?? []) {
      if (edge.type !== "blocks" || !edge.depends_on_id) continue
      heldBy.set(edge.depends_on_id, [...(heldBy.get(edge.depends_on_id) ?? []), issue])
    }
  }
  return { children, heldBy }
}

function toHeld(issue: BdBead, via?: string): GateHeldIssue {
  const held: GateHeldIssue = {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    issueType: issue.issue_type,
  }
  if (via) held.via = via
  return held
}

// Reverse ID order, so popping a stack visits children in ID order.
function childrenOf(id: string, index: ReturnType<typeof indexIssues>): BdBead[] {
  return [...(index.children.get(id) ?? [])].sort((a, b) => b.id.localeCompare(a.id))
}

function heldIssues(gateId: string, index: ReturnType<typeof indexIssues>): GateHeldIssue[] {
  const direct = (index.heldBy.get(gateId) ?? []).filter(isOpen)
  const seen = new Set(direct.map((issue) => issue.id))
  const out: GateHeldIssue[] = []
  for (const issue of direct) {
    out.push(toHeld(issue))
    // Depth-first through the hierarchy, in ID order; `seen` also stops a
    // parent cycle.
    const stack = childrenOf(issue.id, index)
    while (stack.length > 0) {
      const child = stack.pop() as BdBead
      if (seen.has(child.id) || !isOpen(child)) continue
      seen.add(child.id)
      out.push(toHeld(child, issue.id))
      stack.push(...childrenOf(child.id, index))
    }
  }
  return out
}

function toWaitingGate(gate: BdBead, held: GateHeldIssue[]): WaitingGate {
  const out: WaitingGate = {
    id: gate.id,
    title: gate.title,
    description: gate.description ?? "",
    awaitType: gate.await_type ?? "",
    createdAt: gate.created_at,
    held,
  }
  if (gate.await_id) out.awaitId = gate.await_id
  if (typeof gate.timeout === "number" && gate.timeout > 0) {
    out.timeoutMs = Math.round(gate.timeout / NS_PER_MS)
    const created = Date.parse(gate.created_at)
    if (!Number.isNaN(created)) out.deadline = new Date(created + out.timeoutMs).toISOString()
  }
  return out
}

// bd mixes second and sub-second precision across commands, so compare as
// instants, not strings. An unparseable date sorts last.
function ageKey(gate: WaitingGate): number {
  const t = Date.parse(gate.createdAt)
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t
}

/** True when the row is a gate that is still open (neither closed nor tombstoned). */
export function isOpenGate(issue: BdBead): boolean {
  return issue.issue_type === "gate" && isOpen(issue)
}

/**
 * Why `bd gate resolve` must not run for `id`, given bd's own fresh answer for
 * it, or undefined when it may. It must be the exact issue asked for (bd also
 * resolves a unique ID suffix), a gate, still open, and a human gate. Timer,
 * gh:run, gh:pr and bead gates close through `bd gate check`, so they are
 * refused even though bd itself would close them.
 */
export function resolveRefusal(gate: BdBead | null | undefined, id: string): string | undefined {
  if (gate?.id !== id) return `${id} not found`
  if (gate.issue_type !== "gate") return `${id} is not a gate`
  if (!isOpen(gate)) return `${id} is already resolved`
  if (gate.await_type !== "human") {
    return `${id} is a ${gate.await_type ?? "non-human"} gate, not a human gate`
  }
  return undefined
}

/** Open gates, oldest first, each with the open issues it holds. */
export function waitingGates(issues: BdBead[]): WaitingGate[] {
  const index = indexIssues(issues)
  return issues
    .filter(isOpenGate)
    .map((gate) => toWaitingGate(gate, heldIssues(gate.id, index)))
    .sort((a, b) => ageKey(a) - ageKey(b) || a.id.localeCompare(b.id))
}
