// Presentation helpers for the Waiting view (components/waiting-page.tsx).
// Pure, so the wording is testable without rendering the page.

import { formatRelativeTime } from "./activity-utils"

// Human gates use the same warning pill as the formula views; the other types
// get their own token so they can be told apart. The GitHub types take
// `primary` — not a tone, because they are neither a warning nor an error, and
// the three tones are already spoken for by human/timer. Its text uses the
// derived companion: bare `text-primary` on its own 15% tint measures 4.09:1
// on a white card.
const GATE_TYPE_CLASS: Record<string, string> = {
  human: "bg-warning/15 text-warning-text border-warning/20",
  timer: "bg-info/15 text-info-text border-info/20",
  "gh:run": "bg-primary/15 text-primary-text border-primary/20",
  "gh:pr": "bg-primary/15 text-primary-text border-primary/20",
}
const DEFAULT_GATE_CLASS = "bg-muted text-muted-foreground border-border"

/**
 * The whole view's limit on held rows, quoted when it is used up. Mirrors
 * HELD_TOTAL_BUDGET in packages/server/src/lib/gates.ts, which applies it; a
 * server test (gates.unit.test.ts) pins the two together.
 */
export const HELD_TOTAL_BUDGET = 5000

/**
 * The Resolve prompt's count of held beads. A truncated list is a lower bound,
 * never an exact count (spec section 4.11). A truncated gate holds at least one.
 */
export function heldCountText(shown: number, truncated: boolean): string {
  if (truncated) return ` (at least ${Math.max(shown, 1)} open)`
  return shown > 0 ? ` (${shown} open)` : ""
}

export function gateTypeLabel(awaitType: string): string {
  return awaitType ? `${awaitType} gate` : "gate"
}

export function gateTypeClass(awaitType: string): string {
  return GATE_TYPE_CLASS[awaitType] ?? DEFAULT_GATE_CLASS
}

export function waitingSince(createdAt: string): string {
  if (Number.isNaN(Date.parse(createdAt))) return "unknown"
  return formatRelativeTime(createdAt)
}

function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * A timer gate's deadline, relative to now. Once it has passed the gate stays
 * open until `bd gate check` closes it, so the text says so rather than
 * pretending the wait is over.
 */
export function describeDeadline(deadline: string, now: Date = new Date()): string {
  const due = Date.parse(deadline)
  if (Number.isNaN(due)) return ""
  const delta = due - now.getTime()
  if (delta > 0) return `expires in ${formatSpan(delta)}`
  return `expired ${formatSpan(-delta)} ago, closes on the next bd gate check`
}

/**
 * What a gate waits on: bd's await_id exactly as bd gave it (a run ID, a PR
 * number, a bead ID). bd returns no run or PR status, so none is shown.
 */
export function describeAwait(awaitId?: string): string {
  return awaitId ? `awaits ${awaitId}` : ""
}
