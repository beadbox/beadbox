import { getAnalyticsEnabled } from "@/lib/local-storage"
import { safeCapture } from "@/lib/posthog-safe"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldName =
  | "title"
  | "type"
  | "status"
  | "priority"
  | "assignee"
  | "specId"
  | "dueAt"
  | "deferUntil"
  | "estimatedMinutes"
  | "design"
  | "description"
  | "acceptanceCriteria"
  | "notes"

export interface FieldState {
  isSaving: boolean
  hasError: boolean
}

export const initialFieldStates: Record<FieldName, FieldState> = {
  title: { isSaving: false, hasError: false },
  type: { isSaving: false, hasError: false },
  status: { isSaving: false, hasError: false },
  priority: { isSaving: false, hasError: false },
  assignee: { isSaving: false, hasError: false },
  specId: { isSaving: false, hasError: false },
  dueAt: { isSaving: false, hasError: false },
  deferUntil: { isSaving: false, hasError: false },
  estimatedMinutes: { isSaving: false, hasError: false },
  design: { isSaving: false, hasError: false },
  description: { isSaving: false, hasError: false },
  acceptanceCriteria: { isSaving: false, hasError: false },
  notes: { isSaving: false, hasError: false },
}

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const coreStatusConfig: Record<string, { label: string; colorClass: string; dotClass: string }> = {
  open: { label: "Open", colorClass: "text-white", dotClass: "bg-white" },
  in_progress: { label: "In Progress", colorClass: "text-amber-400", dotClass: "bg-amber-500" },
  closed: { label: "Closed", colorClass: "text-zinc-500", dotClass: "bg-zinc-600" },
  ready_for_qa: { label: "Ready for QA", colorClass: "text-purple-400", dotClass: "bg-purple-500" },
  ready_to_ship: {
    label: "Ready to Ship",
    colorClass: "text-emerald-400",
    dotClass: "bg-emerald-500",
  },
}

export function getStatusDisplayConfig(status: string): {
  label: string
  colorClass: string
  dotClass: string
} {
  if (coreStatusConfig[status]) {
    return coreStatusConfig[status]
  }
  return {
    label: status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    colorClass: "text-cyan-400",
    dotClass: "bg-cyan-500",
  }
}

export const typeColors: Record<string, string> = {
  bug: "bg-red-500/20 text-red-400 border-red-500/30",
  task: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  feature: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  epic: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  chore: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  message: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  gate: "bg-green-500/20 text-green-400 border-green-500/30",
  "merge-request": "bg-teal-500/20 text-teal-400 border-teal-500/30",
  molecule: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  agent: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  role: "bg-sky-500/20 text-sky-400 border-sky-500/30",
  rig: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  convoy: "bg-lime-500/20 text-lime-400 border-lime-500/30",
  event: "bg-rose-500/20 text-rose-400 border-rose-500/30",
}

const authorColors = [
  "border-l-emerald-500",
  "border-l-blue-500",
  "border-l-purple-500",
  "border-l-amber-500",
  "border-l-pink-500",
  "border-l-cyan-500",
]

export function getAuthorColor(author: string): string {
  let hash = 0
  for (let i = 0; i < author.length; i++) {
    hash = author.charCodeAt(i) + ((hash << 5) - hash)
  }
  return authorColors[Math.abs(hash) % authorColors.length]
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatDate(date: Date) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export function formatDateTime(date: Date) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function formatRelativeTime(date: Date) {
  const now = new Date()
  const d = new Date(date)
  const diffMs = now.getTime() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)
  const diffWeek = Math.floor(diffDay / 7)
  const diffMonth = Math.floor(diffDay / 30)
  const diffYear = Math.floor(diffDay / 365)

  if (diffSec < 60) return "just now"
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  if (diffWeek < 4) return `${diffWeek}w ago`
  if (diffMonth < 12) return `${diffMonth}mo ago`
  return `${diffYear}y ago`
}

// ---------------------------------------------------------------------------
// Workflow advancement (beadbox-3qo, pm/spec §4.3)
// ---------------------------------------------------------------------------

/**
 * Return the next status to advance to per the workspace's status.custom
 * chain. Pure function; encodes the §4.3 contract:
 *
 * - Empty chain → null (caller hides the button).
 * - `current` is in the chain at a non-terminal position → chain[i + 1].
 * - `current` is the last chain entry → null (terminal; caller hides).
 * - `current` is NOT in the chain (e.g., open / in_progress / blocked /
 *   deferred) → chain[0]. The button advances built-in states into the
 *   custom chain at its head.
 * - `current` is `closed` → null. The closed terminal state never offers
 *   forward progression.
 */
export function getNextStatusInChain(current: string, chain: string[]): string | null {
  if (chain.length === 0) return null
  if (current === "closed") return null
  const idx = chain.indexOf(current)
  if (idx === -1) return chain[0] ?? null
  if (idx === chain.length - 1) return null
  return chain[idx + 1] ?? null
}

/**
 * Discriminated workflow-advancement outcome the detail-panel footer renders
 * against. Distinguishes the three button states §4.3 authorizes:
 *
 * - `advance`: bead can move forward in the chain. Footer shows
 *   "Mark as <Title>"; click writes `targetStatus`.
 * - `close`: bead is at the last chain entry. Per spec §4.3 engineer choice,
 *   we offer the explicit "Close" affordance (click writes status=closed,
 *   which the bd CLI treats as `bd close <id>` semantics).
 * - `hidden`: no advancement applicable — empty chain or bead already closed.
 */
export type WorkflowAdvancement =
  | { kind: "advance"; targetStatus: string }
  | { kind: "close" }
  | { kind: "hidden" }

export function getWorkflowAdvancement(current: string, chain: string[]): WorkflowAdvancement {
  if (chain.length === 0) return { kind: "hidden" }
  if (current === "closed") return { kind: "hidden" }
  const idx = chain.indexOf(current)
  if (idx === -1) return { kind: "advance", targetStatus: chain[0] }
  if (idx === chain.length - 1) return { kind: "close" }
  return { kind: "advance", targetStatus: chain[idx + 1] }
}

// ---------------------------------------------------------------------------
// Analytics helpers
// ---------------------------------------------------------------------------

export function captureDetailPanelAction(
  action: "status_change" | "comment" | "copy_id" | "expand_deps" | "close_panel" | "edit_field",
  issueType: string,
) {
  if (!getAnalyticsEnabled()) return
  safeCapture("app_detail_panel_action", { action, issue_type: issueType })
}
