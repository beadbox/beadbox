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

// colorClass / dotClass are the PRE-STYLESHEET fallback. The real colour
// arrives from the status stylesheet via data-status + data-status-role
// ("text" and "dot"), including any colour chosen in Settings > Workflow.
// Tokens here rather than palette literals so the window before the
// custom-status list loads is legible in a light theme too.
const coreStatusConfig: Record<string, { label: string; colorClass: string; dotClass: string }> = {
  open: { label: "Open", colorClass: "text-foreground", dotClass: "bg-foreground" },
  in_progress: {
    label: "In Progress",
    colorClass: "text-warning-text",
    dotClass: "bg-warning",
  },
  closed: { label: "Closed", colorClass: "text-muted-foreground", dotClass: "bg-muted-foreground" },
  ready_for_qa: { label: "Ready for QA", colorClass: "text-info-text", dotClass: "bg-info" },
  ready_to_ship: {
    label: "Ready to Ship",
    colorClass: "text-success-text",
    dotClass: "bg-success",
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
    colorClass: "text-info-text",
    dotClass: "bg-info",
  }
}

/**
 * Base class for a bead-type badge; the per-type hue comes from the type
 * stylesheet via data-type (DEFAULT_TYPE_HEX). This neutral is what a
 * workspace-defined type with no entry of its own draws.
 */
export const TYPE_BADGE_CLASS = "bg-muted/40 text-muted-foreground border-border"

/**
 * One left-border colour per comment author, by hash. Identity colours, not
 * semantic roles: do NOT collapse onto tone tokens — two authors would share
 * a stripe. Literal on purpose; a saturated border reads on either surface.
 */
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
// Labels
// ---------------------------------------------------------------------------

/**
 * The label to add for what the user typed, or null to ignore it (beadbox-m4i).
 * Trimmed, as bd trims. Refused: blank; a comma, because bd's --add-label
 * splits on commas and would store several labels where the panel shows one
 * chip; a leading "-", which `bd label` would parse as a flag; and a label the
 * bead already has.
 */
export function normalizeNewLabel(raw: string, existing: readonly string[]): string | null {
  const label = raw.trim()
  if (!label || label.startsWith("-") || label.includes(",")) return null
  return existing.includes(label) ? null : label
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
