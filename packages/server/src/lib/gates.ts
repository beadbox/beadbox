// Open gates and the issues they hold, from one `bd list --include-gates`
// result. Lives outside lib/bd.ts because it never runs bd: bd.ts's exports
// are the argv surface the security census enumerates.
//
// A gate holds an issue through a "blocks" dependency on the gate. bd also
// withholds every descendant of a held issue from `bd ready` (an epic gate
// withholds its children), so descendants are listed too, tagged with the
// gated ancestor they wait through.
//
// The repository decides how many gates block how many issues with how many
// descendants, so held lists are bounded by constants, never by the input's
// shape (spec section 4.11 "Bounds on the held list"; beadbox-sun FIX-1). A gate whose
// list was cut carries heldTruncated, and the view says so.

import type { BdBead } from "./bd"
import type { GateHeldIssue, GateWait, WaitingGate } from "./types"

const DONE_STATUSES = new Set(["closed", "tombstone"])
const NS_PER_MS = 1_000_000

/** Held rows listed for one gate at most. */
export const HELD_PER_GATE_CAP = 200
/** Held rows listed across every gate at most; oldest gates spend it first. */
export const HELD_TOTAL_BUDGET = 5000

function isOpen(issue: BdBead): boolean {
  return !DONE_STATUSES.has(issue.status)
}

function parentOf(issue: BdBead): string | undefined {
  if (issue.parent) return issue.parent
  return issue.dependencies?.find((edge) => edge.type === "parent-child")?.depends_on_id
}

function append(map: Map<string, BdBead[]>, key: string, issue: BdBead): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(issue)
  else map.set(key, [issue])
}

// Only open issues are indexed: a closed issue is not held, and neither are its
// descendants, so the walk never has to step over them.
function indexIssues(issues: BdBead[]) {
  const children = new Map<string, BdBead[]>()
  const heldBy = new Map<string, BdBead[]>()
  for (const issue of issues) {
    if (!isOpen(issue)) continue
    const parent = parentOf(issue)
    if (parent) append(children, parent, issue)
    for (const edge of issue.dependencies ?? []) {
      if (edge.type !== "blocks" || !edge.depends_on_id) continue
      append(heldBy, edge.depends_on_id, issue)
    }
  }
  // Sorted once here, not on every visit: children are walked in ID order.
  for (const bucket of children.values()) bucket.sort((a, b) => a.id.localeCompare(b.id))
  return { children, heldBy }
}

type IssueIndex = ReturnType<typeof indexIssues>

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

const NO_CHILDREN: readonly BdBead[] = []

function childrenOf(id: string, index: IssueIndex): readonly BdBead[] {
  return index.children.get(id) ?? NO_CHILDREN
}

/**
 * The open issues a gate holds, at most `limit` of them. `truncated` is true
 * when there were more. The walk stops at the limit, and it reads the index in
 * place (a cursor per level, no copies), so its cost follows what it lists,
 * not the size of the hierarchy under it.
 */
function heldIssues(
  gateId: string,
  index: IssueIndex,
  limit: number,
): { held: GateHeldIssue[]; truncated: boolean } {
  const direct = index.heldBy.get(gateId) ?? NO_CHILDREN
  const held: GateHeldIssue[] = []
  if (limit <= 0) return { held, truncated: direct.length > 0 }
  const seen = new Set(direct.map((issue) => issue.id))
  for (const issue of direct) {
    if (held.length >= limit) return { held, truncated: true }
    held.push(toHeld(issue))
    // Depth-first through the hierarchy, in ID order; `seen` also stops a
    // parent cycle.
    const levels = [{ list: childrenOf(issue.id, index), next: 0 }]
    while (levels.length > 0) {
      const level = levels[levels.length - 1] as { list: readonly BdBead[]; next: number }
      if (level.next >= level.list.length) {
        levels.pop()
        continue
      }
      const child = level.list[level.next++] as BdBead
      if (seen.has(child.id)) continue
      if (held.length >= limit) return { held, truncated: true }
      seen.add(child.id)
      held.push(toHeld(child, issue.id))
      levels.push({ list: childrenOf(child.id, index), next: 0 })
    }
  }
  return { held, truncated: false }
}

function toWaitingGate(gate: BdBead, held: GateHeldIssue[], truncated: boolean): WaitingGate {
  const out: WaitingGate = {
    id: gate.id,
    title: gate.title,
    description: gate.description ?? "",
    awaitType: gate.await_type ?? "",
    createdAt: gate.created_at,
    held,
  }
  if (truncated) out.heldTruncated = true
  if (gate.await_id) out.awaitId = gate.await_id
  const timeoutMs = gateTimeoutMs(gate)
  if (timeoutMs !== undefined) {
    out.timeoutMs = timeoutMs
    const deadline = gateDeadline(gate)
    if (deadline) out.deadline = deadline
  }
  return out
}

function gateTimeoutMs(gate: BdBead): number | undefined {
  if (typeof gate.timeout !== "number" || gate.timeout <= 0) return undefined
  return Math.round(gate.timeout / NS_PER_MS)
}

/** A gate's deadline: createdAt + bd's timeout, when it has one. */
export function gateDeadline(gate: BdBead): string | undefined {
  const timeoutMs = gateTimeoutMs(gate)
  const created = Date.parse(gate.created_at)
  if (timeoutMs === undefined || Number.isNaN(created)) return undefined
  return new Date(created + timeoutMs).toISOString()
}

/** What a gate issue waits on, for the tree's gate rows (beadbox-wya0.2). */
export function toGateWait(gate: BdBead): GateWait {
  const wait: GateWait = { awaitType: gate.await_type ?? "" }
  if (gate.await_id) wait.awaitId = gate.await_id
  const deadline = gateDeadline(gate)
  if (deadline) wait.deadline = deadline
  return wait
}

// bd mixes second and sub-second precision across commands, so compare as
// instants, not strings. An unparseable date sorts last.
function ageKey(gate: BdBead): number {
  const t = Date.parse(gate.created_at)
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

/**
 * Open gates, oldest first, each with the open issues it holds: at most
 * HELD_PER_GATE_CAP per gate and HELD_TOTAL_BUDGET in all, spent oldest gate
 * first. Every gate is listed; only held lists are cut.
 */
export function waitingGates(issues: BdBead[]): WaitingGate[] {
  const index = indexIssues(issues)
  const gates = issues
    .filter(isOpenGate)
    .sort((a, b) => ageKey(a) - ageKey(b) || a.id.localeCompare(b.id))
  let budget = HELD_TOTAL_BUDGET
  return gates.map((gate) => {
    const { held, truncated } = heldIssues(gate.id, index, Math.min(HELD_PER_GATE_CAP, budget))
    budget -= held.length
    return toWaitingGate(gate, held, truncated)
  })
}
