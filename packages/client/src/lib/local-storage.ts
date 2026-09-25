import type { Bead, Filters, ReadState, SortOption } from "./types"

export type ThemeVariant = "blue" | "gray" | "green"

const SORT_KEY = "beads-sort"
const FILTERS_KEY = "beads-filters"
const THEME_KEY = "beads-theme"
const ANALYTICS_KEY = "beadbox_analytics_enabled"
const ZOOM_KEY = "beadbox_zoom_level"
const VIM_NAV_KEY = "beadbox_vim_navigation"
const UPDATE_CHECK_ENABLED_KEY = "beadbox_update_check_enabled"
const UPDATE_CHECK_FREQUENCY_KEY = "beadbox_update_check_frequency"
const UPDATE_DISMISSED_VERSION_KEY = "beadbox_update_dismissed_version"
const WORKSPACE_HINT_KEY = "beadbox_workspace_hint_dismissed"
const ARCHIVE_HINT_KEY = "beadbox-archive-hint-shown"
const READ_STATE_KEY = "beadbox_read_state"
const COMMENT_SORT_KEY = "beadbox_comment_sort"
const FILTER_BAR_VISIBLE_KEY = "beadbox_filter_bar_visible"
const SELECTED_FORMULA_KEY = "beadbox_selected_formula"
const FORMULA_VIEW_MODE_KEY = "beadbox_formula_view_mode"
const WORKSPACE_RAIL_WIDTH_KEY = "beadbox_workspace_rail_width"
const WORKSPACE_RAIL_COLLAPSED_KEY = "beadbox_workspace_rail_collapsed"

export type CommentSortOrder = "newest" | "oldest"

const DEFAULT_SORT: SortOption = { field: "status", direction: "desc" }

// beadbox-brg: defaults include the canonical core + chain statuses so a
// fresh install shows everything until the user narrows. Custom statuses
// outside this set need an explicit toggle (the FilterBar's master "All
// Status" pulls them in automatically once availableStatuses is loaded).
const DEFAULT_STATUSES = [
  "open",
  "in_progress",
  "closed",
  "ready_for_qa",
  "qa_passed",
  "ready_to_ship",
  "blocked",
  "deferred",
] as const

const DEFAULT_FILTERS: Filters = {
  status: [...DEFAULT_STATUSES],
  assignee: "all",
  priority: "all",
  showMessages: false,
  showWaves: false,
  hasSpec: false,
  hasDeadline: false,
  search: "",
  rig: "all",
  grouped: false,
}

export function getSortPreference(): SortOption {
  if (typeof window === "undefined") return DEFAULT_SORT

  try {
    const stored = localStorage.getItem(SORT_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (parsed.field && parsed.direction) {
        return parsed as SortOption
      }
    }
  } catch {
    // Invalid JSON or other error, use default
  }
  return DEFAULT_SORT
}

export function setSortPreference(sort: SortOption): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(sort))
  } catch {
    // localStorage might be full or disabled
  }
}

export function getFiltersPreference(): Filters {
  if (typeof window === "undefined") return DEFAULT_FILTERS

  try {
    const stored = localStorage.getItem(FILTERS_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      // beadbox-brg: migrate pre-multi-select shape where status was a
      // singleton string. Legacy 'all' → the canonical default set so the
      // user keeps seeing what they were seeing (every status); a specific
      // status (e.g. 'open') becomes a single-element whitelist. Existing
      // array form passes through. Anything malformed → canonical default.
      if (typeof parsed.status === "string") {
        parsed.status = parsed.status === "all" ? [...DEFAULT_STATUSES] : [parsed.status]
      } else if (!Array.isArray(parsed.status)) {
        parsed.status = [...DEFAULT_STATUSES]
      }
      return { ...DEFAULT_FILTERS, ...parsed }
    }
  } catch {
    // Invalid JSON or other error, use default
  }
  return DEFAULT_FILTERS
}

export function setFiltersPreference(filters: Filters): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters))
  } catch {
    // localStorage might be full or disabled
  }
}

const VALID_THEMES: ThemeVariant[] = ["blue", "gray", "green"]

export function getThemePreference(): ThemeVariant {
  if (typeof window === "undefined") return "gray"

  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored && VALID_THEMES.includes(stored as ThemeVariant)) {
      return stored as ThemeVariant
    }
  } catch {
    // Invalid or unavailable
  }
  return "gray"
}

export function setThemePreference(theme: ThemeVariant): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Analytics opt-out ---

export function getAnalyticsEnabled(): boolean {
  if (typeof window === "undefined") return true

  try {
    const stored = localStorage.getItem(ANALYTICS_KEY)
    if (stored === "false") return false
  } catch {
    // localStorage unavailable
  }
  return true // Default: opted in
}

export function setAnalyticsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(ANALYTICS_KEY, String(enabled))
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Zoom level (Tauri only) ---

const MIN_ZOOM = 50
const MAX_ZOOM = 200
const DEFAULT_ZOOM = 100

export function getZoomLevel(): number {
  if (typeof window === "undefined") return DEFAULT_ZOOM

  try {
    const stored = localStorage.getItem(ZOOM_KEY)
    if (stored) {
      const level = parseInt(stored, 10)
      if (!Number.isNaN(level) && level >= MIN_ZOOM && level <= MAX_ZOOM) {
        return level
      }
    }
  } catch {
    // Invalid or unavailable
  }
  return DEFAULT_ZOOM
}

export function setZoomLevel(level: number): void {
  if (typeof window === "undefined") return

  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level))
  try {
    localStorage.setItem(ZOOM_KEY, String(clamped))
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Vim-style navigation toggle ---

export function getVimNavigationEnabled(): boolean {
  if (typeof window === "undefined") return true

  try {
    const stored = localStorage.getItem(VIM_NAV_KEY)
    if (stored === "false") return false
  } catch {
    // localStorage unavailable
  }
  return true // Default: enabled
}

export function setVimNavigationEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(VIM_NAV_KEY, String(enabled))
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Update checker settings ---

export type UpdateCheckFrequency = 1800000 | 3600000 | 14400000 | 86400000

const VALID_FREQUENCIES: UpdateCheckFrequency[] = [1800000, 3600000, 14400000, 86400000]
const DEFAULT_FREQUENCY: UpdateCheckFrequency = 3600000 // 60 minutes

export function getUpdateCheckEnabled(): boolean {
  if (typeof window === "undefined") return true

  try {
    const stored = localStorage.getItem(UPDATE_CHECK_ENABLED_KEY)
    if (stored === "false") return false
  } catch {
    // localStorage unavailable
  }
  return true // Default: enabled
}

export function setUpdateCheckEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(UPDATE_CHECK_ENABLED_KEY, String(enabled))
  } catch {
    // localStorage might be full or disabled
  }
}

export function getUpdateCheckFrequency(): UpdateCheckFrequency {
  if (typeof window === "undefined") return DEFAULT_FREQUENCY

  try {
    const stored = localStorage.getItem(UPDATE_CHECK_FREQUENCY_KEY)
    if (stored) {
      const val = parseInt(stored, 10) as UpdateCheckFrequency
      if (VALID_FREQUENCIES.includes(val)) return val
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_FREQUENCY
}

export function setUpdateCheckFrequency(frequency: UpdateCheckFrequency): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(UPDATE_CHECK_FREQUENCY_KEY, String(frequency))
  } catch {
    // localStorage might be full or disabled
  }
}

export function getUpdateDismissedVersion(): string | null {
  if (typeof window === "undefined") return null

  try {
    return localStorage.getItem(UPDATE_DISMISSED_VERSION_KEY)
  } catch {
    // localStorage unavailable
  }
  return null
}

export function setUpdateDismissedVersion(version: string | null): void {
  if (typeof window === "undefined") return

  try {
    if (version) {
      localStorage.setItem(UPDATE_DISMISSED_VERSION_KEY, version)
    } else {
      localStorage.removeItem(UPDATE_DISMISSED_VERSION_KEY)
    }
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Workspace hint (first-launch popover) ---

export function getWorkspaceHintDismissed(): boolean {
  if (typeof window === "undefined") return true

  try {
    return localStorage.getItem(WORKSPACE_HINT_KEY) === "true"
  } catch {
    // localStorage unavailable
  }
  return true
}

export function setWorkspaceHintDismissed(): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(WORKSPACE_HINT_KEY, "true")
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Archive onboarding hint (one-time toast) ---

export function getArchiveHintShown(): boolean {
  if (typeof window === "undefined") return true

  try {
    return localStorage.getItem(ARCHIVE_HINT_KEY) === "true"
  } catch {
    // localStorage unavailable
  }
  return true
}

export function setArchiveHintShown(): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(ARCHIVE_HINT_KEY, "true")
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Read state (unread indicators) ---

export function getReadState(): ReadState {
  if (typeof window === "undefined") return {}

  try {
    const stored = localStorage.getItem(READ_STATE_KEY)
    if (stored) {
      return JSON.parse(stored) as ReadState
    }
  } catch {
    // Invalid JSON or unavailable
  }
  return {}
}

export function setReadState(state: ReadState): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(READ_STATE_KEY, JSON.stringify(state))
  } catch {
    // localStorage might be full or disabled
  }
}

export function markBeadRead(beadId: string, bead: Bead): ReadState {
  const state = getReadState()
  state[beadId] = {
    viewedAt: new Date().toISOString(),
    commentCount: bead.commentCount ?? bead.comments?.length ?? 0,
  }
  setReadState(state)
  return state
}

export function initializeReadState(beads: Bead[]): ReadState {
  const now = new Date().toISOString()
  const state: ReadState = {}
  for (const bead of beads) {
    state[bead.id] = {
      viewedAt: now,
      commentCount: bead.commentCount ?? bead.comments?.length ?? 0,
    }
  }
  setReadState(state)
  return state
}

export function markAllBeadsRead(beads: Bead[]): ReadState {
  const state = getReadState()
  const now = new Date().toISOString()
  for (const bead of beads) {
    state[bead.id] = {
      viewedAt: now,
      commentCount: bead.commentCount ?? bead.comments?.length ?? 0,
    }
  }
  setReadState(state)
  return state
}

export function isBeadUnread(bead: Bead, readState: ReadState): boolean {
  const entry = readState[bead.id]
  if (!entry) return true // Never viewed = unread

  // Field changes: updated_at moved since last view
  if (bead.updatedAt) {
    const updatedAt =
      bead.updatedAt instanceof Date ? bead.updatedAt.toISOString() : String(bead.updatedAt)
    if (updatedAt > entry.viewedAt) return true
  }

  // New comments: count increased since last view
  const currentCommentCount = bead.commentCount ?? bead.comments?.length ?? 0
  if (currentCommentCount > entry.commentCount) return true

  return false
}

export function getUnreadReason(bead: Bead, readState: ReadState): string | null {
  const entry = readState[bead.id]
  if (!entry) return "New bead"

  const currentCommentCount = bead.commentCount ?? bead.comments?.length ?? 0
  const hasNewComments = currentCommentCount > entry.commentCount

  let hasFieldChanges = false
  if (bead.updatedAt) {
    const updatedAt =
      bead.updatedAt instanceof Date ? bead.updatedAt.toISOString() : String(bead.updatedAt)
    hasFieldChanges = updatedAt > entry.viewedAt
  }

  // Prefer comment reason (more specific) when both changed
  if (hasNewComments) {
    const newCount = currentCommentCount - entry.commentCount
    return `New comments (${newCount} new)`
  }

  if (hasFieldChanges) {
    return `Updated since last viewed`
  }

  return null
}

// --- Filter bar visibility ---

export function getFilterBarVisible(): boolean {
  if (typeof window === "undefined") return true

  try {
    const stored = localStorage.getItem(FILTER_BAR_VISIBLE_KEY)
    if (stored === "false") return false
  } catch {
    // localStorage unavailable
  }
  return true // Default: visible
}

export function setFilterBarVisible(visible: boolean): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(FILTER_BAR_VISIBLE_KEY, String(visible))
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Comment sort order ---

export function getCommentSortOrder(): CommentSortOrder {
  if (typeof window === "undefined") return "newest"

  try {
    const stored = localStorage.getItem(COMMENT_SORT_KEY)
    if (stored === "newest" || stored === "oldest") return stored
  } catch {
    // localStorage unavailable
  }
  return "newest"
}

export function setCommentSortOrder(order: CommentSortOrder): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(COMMENT_SORT_KEY, order)
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Workspace rail (left project switcher) ---

export const MIN_WORKSPACE_RAIL_WIDTH = 180
export const MAX_WORKSPACE_RAIL_WIDTH = 420
const DEFAULT_WORKSPACE_RAIL_WIDTH = 240

export function clampWorkspaceRailWidth(width: number): number {
  return Math.max(MIN_WORKSPACE_RAIL_WIDTH, Math.min(MAX_WORKSPACE_RAIL_WIDTH, Math.round(width)))
}

export function getWorkspaceRailWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_RAIL_WIDTH

  try {
    const stored = localStorage.getItem(WORKSPACE_RAIL_WIDTH_KEY)
    if (stored) {
      const width = parseInt(stored, 10)
      if (!Number.isNaN(width)) return clampWorkspaceRailWidth(width)
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_WORKSPACE_RAIL_WIDTH
}

export function setWorkspaceRailWidth(width: number): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(WORKSPACE_RAIL_WIDTH_KEY, String(clampWorkspaceRailWidth(width)))
  } catch {
    // localStorage might be full or disabled
  }
}

export function getWorkspaceRailCollapsed(): boolean {
  if (typeof window === "undefined") return false

  try {
    if (localStorage.getItem(WORKSPACE_RAIL_COLLAPSED_KEY) === "true") return true
  } catch {
    // localStorage unavailable
  }
  return false // Default: expanded
}

export function setWorkspaceRailCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(WORKSPACE_RAIL_COLLAPSED_KEY, String(collapsed))
  } catch {
    // localStorage might be full or disabled
  }
}

// --- Cache management ---

const CLEARABLE_KEYS = [
  SORT_KEY,
  FILTERS_KEY,
  THEME_KEY,
  ANALYTICS_KEY,
  ZOOM_KEY,
  VIM_NAV_KEY,
  UPDATE_CHECK_ENABLED_KEY,
  UPDATE_CHECK_FREQUENCY_KEY,
  UPDATE_DISMISSED_VERSION_KEY,
  WORKSPACE_HINT_KEY,
  ARCHIVE_HINT_KEY,
  READ_STATE_KEY,
  COMMENT_SORT_KEY,
  FILTER_BAR_VISIBLE_KEY,
  WORKSPACE_RAIL_WIDTH_KEY,
  WORKSPACE_RAIL_COLLAPSED_KEY,
]

export function clearCache(): void {
  if (typeof window === "undefined") return

  try {
    for (const key of CLEARABLE_KEYS) {
      localStorage.removeItem(key)
    }
    sessionStorage.clear()
  } catch {
    // Storage might be disabled
  }
}

// --- Session-scoped UI state (sessionStorage) ---

const EXPANDED_EPICS_KEY = "beads-expanded"
const SELECTED_BEAD_KEY = "beads-selected-bead"
const EXPANDED_BEADS_KEY = "beads-expanded-beads"

export function getExpandedEpics(): string[] {
  if (typeof window === "undefined") return []

  try {
    const stored = sessionStorage.getItem(EXPANDED_EPICS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    // Invalid JSON or unavailable
  }
  return []
}

export function setExpandedEpics(ids: string[]): void {
  if (typeof window === "undefined") return

  try {
    sessionStorage.setItem(EXPANDED_EPICS_KEY, JSON.stringify(ids))
  } catch {
    // sessionStorage might be full or disabled
  }
}

export function getSelectedBead(): string | null {
  if (typeof window === "undefined") return null

  try {
    return sessionStorage.getItem(SELECTED_BEAD_KEY)
  } catch {
    // sessionStorage unavailable
  }
  return null
}

export function setSelectedBead(id: string | null): void {
  if (typeof window === "undefined") return

  try {
    if (id) {
      sessionStorage.setItem(SELECTED_BEAD_KEY, id)
    } else {
      sessionStorage.removeItem(SELECTED_BEAD_KEY)
    }
  } catch {
    // sessionStorage might be full or disabled
  }
}

export function getExpandedBeads(): string[] {
  if (typeof window === "undefined") return []

  try {
    const stored = sessionStorage.getItem(EXPANDED_BEADS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    // Invalid JSON or unavailable
  }
  return []
}

export function setExpandedBeads(ids: string[]): void {
  if (typeof window === "undefined") return

  try {
    sessionStorage.setItem(EXPANDED_BEADS_KEY, JSON.stringify(ids))
  } catch {
    // sessionStorage might be full or disabled
  }
}

export function getSelectedFormula(): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(SELECTED_FORMULA_KEY)
  } catch {
    return null
  }
}

export function setSelectedFormula(name: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (name) {
      localStorage.setItem(SELECTED_FORMULA_KEY, name)
    } else {
      localStorage.removeItem(SELECTED_FORMULA_KEY)
    }
  } catch {
    // localStorage might be full or disabled
  }
}

export type FormulaViewMode = "dag" | "tree"

export function getFormulaViewMode(): FormulaViewMode {
  if (typeof window === "undefined") return "tree"
  try {
    const v = localStorage.getItem(FORMULA_VIEW_MODE_KEY)
    return v === "dag" ? "dag" : "tree"
  } catch {
    return "tree"
  }
}

export function setFormulaViewMode(mode: FormulaViewMode): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(FORMULA_VIEW_MODE_KEY, mode)
  } catch {
    // localStorage might be full or disabled
  }
}
