import { type Appearance, THEME_ID_RE } from "@beadbox/server/theme-tokens"
import {
  ALL_PRIORITIES,
  type Bead,
  type BeadPriority,
  DEFAULT_STATUSES,
  type Filters,
  type ReadState,
  type SortOption,
} from "./types"

export type ThemeId = string

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
const ARCHIVE_EXPANDED_KEY = "beadbox_archive_expanded"
const SELECTED_FORMULA_KEY = "beadbox_selected_formula"
const FORMULA_VIEW_MODE_KEY = "beadbox_formula_view_mode"
const WORKSPACE_RAIL_WIDTH_KEY = "beadbox_workspace_rail_width"
const WORKSPACE_RAIL_COLLAPSED_KEY = "beadbox_workspace_rail_collapsed"

export type CommentSortOrder = "newest" | "oldest"

const DEFAULT_SORT: SortOption = { field: "status", direction: "desc" }

// beadbox-brg: defaults include the canonical core + chain statuses so a
// fresh install shows everything until the user narrows. beadbox-429: that
// default selection is read as every listed status (lib/types.ts), so a
// workspace's own custom statuses are shown too.
const DEFAULT_FILTERS: Filters = {
  status: [...DEFAULT_STATUSES],
  assignee: "all",
  priority: [],
  labels: [],
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

// beadbox-813: priority went from one value ('all' | 'high' | ...) to a
// multi-select list where empty means "All Priority". A stored single value
// keeps showing the same view: 'all' becomes [], one priority a one-item list.
// Unknown entries are dropped and anything malformed means All.
function migratePriority(stored: unknown): BeadPriority[] {
  const known = (v: unknown): v is BeadPriority => ALL_PRIORITIES.includes(v as BeadPriority)
  if (Array.isArray(stored)) return stored.filter(known)
  if (known(stored)) return [stored]
  return []
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
      parsed.labels = Array.isArray(parsed.labels)
        ? [
            ...new Set(
              parsed.labels.filter((label: unknown): label is string => typeof label === "string"),
            ),
          ]
        : []
      parsed.priority = migratePriority(parsed.priority)
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

export const DEFAULT_THEME_ID = "beadbox-dark"
export const DEFAULT_LIGHT_THEME_ID = "beadbox-light"

/**
 * The default theme id for a given appearance slot — the one fact (final
 * whole-plan review, Fix 1) that loadTheme's failure path, resolveThemeId's
 * display fallback, and DEFAULT_THEME_PREFS below all read, instead of each
 * independently assuming "dark" and silently breaking the light slot.
 */
export function defaultThemeIdFor(appearance: Appearance): ThemeId {
  return appearance === "dark" ? DEFAULT_THEME_ID : DEFAULT_LIGHT_THEME_ID
}

// THEME_ID_RE itself now lives in @beadbox/server/theme-tokens (Fix 8, final
// whole-branch review): theme-validate.ts's validateTheme() shares this
// exact pattern, so a format relaxed on one side can no longer silently
// mismatch the other and make setThemeForAppearance below reject an id that
// validates and lists fine.

// The theme preference is
// observed by multiple independent call sites (use-theme.ts, usePreferences,
// and whatever else reads it), so a write here must notify all of them —
// mirrors lib/workspace-cookie.ts's module-scoped EventTarget pub/sub.
const themePreferenceEvents = new EventTarget()
const THEME_PREFERENCE_CHANGE_EVENT = "theme-preference-change"

/**
 * Subscribe to theme-preference changes. The listener fires AFTER each
 * writeThemePrefs write (setThemeMode, setThemeForAppearance, clearCache).
 * Returns an unsubscribe function. The listener receives no arguments —
 * read getThemePrefs() inside the listener to get the current value.
 *
 * Pair with getThemePrefs via useSyncExternalStore so every consumer
 * (use-theme.ts, use-theme-preference.ts) observes the same single store
 * instead of holding its own copy.
 */
export function subscribeThemePreference(listener: () => void): () => void {
  themePreferenceEvents.addEventListener(THEME_PREFERENCE_CHANGE_EVENT, listener)
  return () => {
    themePreferenceEvents.removeEventListener(THEME_PREFERENCE_CHANGE_EVENT, listener)
  }
}

// Clears the in-memory fallback so a test can simulate a fresh module/page
// load that reads whatever is actually in storage.
export function _resetThemePreferenceForTests(): void {
  currentThemePrefs = null
}

/**
 * The theme id that actually renders for a stored preference: the stored id
 * if it is one we can render, else the default FOR THIS APPEARANCE. Used for
 * SELECTION DISPLAY only — the stored preference itself is never rewritten,
 * so a theme the user removes and later restores comes back as their
 * choice. The appearance param matters: falling back to the dark default
 * for an unresolvable id in the LIGHT grid would never match any light
 * card, so no card there would ever show as selected (final whole-plan
 * review, Fix 1).
 */
export function resolveThemeId(
  stored: ThemeId,
  availableIds: readonly string[],
  appearance: Appearance,
): ThemeId {
  return availableIds.includes(stored) ? stored : defaultThemeIdFor(appearance)
}

// --- Appearance mode ---
//
// A second axis on top of the single theme id above: the user picks a MODE
// (dark / light / follow the system) and assigns a theme to each of the dark
// and light slots. All three values live in one storage key so a change
// produces ONE store notification instead of three keys that can drift
// mid-update.

const THEME_PREFS_KEY = "beads-theme-prefs"

export type ThemeMode = "dark" | "light" | "system"

export interface ThemePrefs {
  mode: ThemeMode
  darkThemeId: ThemeId
  lightThemeId: ThemeId
}

export const DEFAULT_THEME_PREFS: ThemePrefs = {
  mode: "dark",
  darkThemeId: defaultThemeIdFor("dark"),
  lightThemeId: defaultThemeIdFor("light"),
}

const THEME_MODES: readonly ThemeMode[] = ["dark", "light", "system"]
const isThemeMode = (v: unknown): v is ThemeMode => THEME_MODES.includes(v as ThemeMode)

// In-memory fallback/cache for the current session. getThemePrefs prefers
// this when set, both so a write that survives only in memory (localStorage
// threw) is visible this session, and so a successful parse is cached:
// useSyncExternalStore (Task 4) compares snapshots by identity, and a
// freshly parsed object on every call would re-render forever.
let currentThemePrefs: ThemePrefs | null = null

export function getThemePrefs(): ThemePrefs {
  if (typeof window === "undefined") return DEFAULT_THEME_PREFS
  if (currentThemePrefs !== null) return currentThemePrefs

  try {
    const raw = localStorage.getItem(THEME_PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ThemePrefs>
      // Each field is validated independently and falls back on its own, so a
      // single bad value cannot discard the user's other two choices.
      const next: ThemePrefs = {
        mode: isThemeMode(parsed.mode) ? parsed.mode : DEFAULT_THEME_PREFS.mode,
        darkThemeId:
          typeof parsed.darkThemeId === "string" && THEME_ID_RE.test(parsed.darkThemeId)
            ? parsed.darkThemeId
            : DEFAULT_THEME_PREFS.darkThemeId,
        lightThemeId:
          typeof parsed.lightThemeId === "string" && THEME_ID_RE.test(parsed.lightThemeId)
            ? parsed.lightThemeId
            : DEFAULT_THEME_PREFS.lightThemeId,
      }
      // Cache the parsed result so a second call returns the SAME object
      // (see the comment on currentThemePrefs above), not just an equal one.
      currentThemePrefs = next
      return next
    }
  } catch {
    // Unparseable blob or localStorage unavailable (private mode, disabled
    // storage). Defaults render today's appearance, so this degrades rather
    // than failing.
  }
  return DEFAULT_THEME_PREFS
}

function writeThemePrefs(next: ThemePrefs): void {
  currentThemePrefs = next
  try {
    localStorage.setItem(THEME_PREFS_KEY, JSON.stringify(next))
  } catch {
    // Non-fatal: currentThemePrefs above already holds the new value, so
    // getThemePrefs returns it and the choice applies for this session even
    // though it will not persist across reloads.
  }
  // Dispatched outside the try/catch for the same reason: subscribers must
  // still be notified when the write itself failed, or "applies for this
  // session" would not be true.
  themePreferenceEvents.dispatchEvent(new Event(THEME_PREFERENCE_CHANGE_EVENT))
}

export function setThemeMode(mode: ThemeMode): void {
  if (typeof window === "undefined") return
  if (!isThemeMode(mode)) return
  writeThemePrefs({ ...getThemePrefs(), mode })
}

export function setThemeForAppearance(appearance: Appearance, id: ThemeId): void {
  if (typeof window === "undefined") return
  if (!THEME_ID_RE.test(id)) return
  const prefs = getThemePrefs()
  writeThemePrefs(
    appearance === "dark" ? { ...prefs, darkThemeId: id } : { ...prefs, lightThemeId: id },
  )
}

/**
 * Whether the three-value prefs key has ever been written.
 *
 * Distinguishes "never migrated" from "migrated and happens to hold the
 * defaults" — getThemePrefs() returns DEFAULT_THEME_PREFS for both, so the
 * migration in use-theme.ts cannot tell them apart without this.
 */
export function hasThemePrefs(): boolean {
  if (typeof window === "undefined") return false
  try {
    return localStorage.getItem(THEME_PREFS_KEY) !== null
  } catch {
    // localStorage unavailable — treat as "nothing stored", so a session
    // that cannot read storage does not repeatedly attempt a migration it
    // cannot persist.
    return false
  }
}

/**
 * The pre-§6 single-id key, for one-time migration.
 *
 * Reading it here rather than migrating here is deliberate: choosing which
 * slot the id belongs in needs the theme's `appearance`, which only the
 * loaded theme list knows. hooks/use-theme.ts owns that step (Task 4).
 */
export function getLegacyThemeId(): ThemeId | null {
  if (typeof window === "undefined") return null
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored && THEME_ID_RE.test(stored)) return stored
  } catch {
    // localStorage unavailable.
  }
  return null
}

export function clearLegacyThemeId(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(THEME_KEY)
  } catch {
    // localStorage unavailable; nothing to clear.
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
      if (!isNaN(level) && level >= MIN_ZOOM && level <= MAX_ZOOM) {
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

// Clear Cache resets preferences and UI state, but never the user's opt-outs.
// ANALYTICS_KEY and UPDATE_CHECK_ENABLED_KEY both default to "on" when absent,
// so removing them here would silently turn analytics and automatic update
// checks back on for someone who had switched them off.
const CLEARABLE_KEYS = [
  SORT_KEY,
  FILTERS_KEY,
  THEME_KEY,
  THEME_PREFS_KEY,
  ZOOM_KEY,
  VIM_NAV_KEY,
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
  // Reset theme preference and notify subscribers outside try/catch, so the
  // reset and notification happen even when storage clear throws, ensuring
  // the in-memory value doesn't become stale.
  currentThemePrefs = null
  themePreferenceEvents.dispatchEvent(new Event(THEME_PREFERENCE_CHANGE_EVENT))
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

// beadbox-e04o.2: the molecule steps the tree has already seen, each with
// whether it was finished then, so a step opens on first sight (unless
// finished), collapses once when it finishes, and a user's own toggle sticks.
const SEEN_STEPS_KEY = "beads-seen-steps"

export function getSeenSteps(): Record<string, boolean> {
  if (typeof window === "undefined") return {}
  try {
    const stored = sessionStorage.getItem(SEEN_STEPS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    // Invalid JSON or unavailable
  }
  return {}
}

export function setSeenSteps(seen: Record<string, boolean>): void {
  if (typeof window === "undefined") return
  try {
    sessionStorage.setItem(SEEN_STEPS_KEY, JSON.stringify(seen))
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

// beadbox-51m: whether the Archived group is expanded. Default COLLAPSED, so
// archived items stay hidden until the user opens the group, and the choice
// sticks across remounts, workspace switches and relaunches.
export function getArchiveExpanded(): boolean {
  if (typeof window === "undefined") return false
  try {
    return localStorage.getItem(ARCHIVE_EXPANDED_KEY) === "true"
  } catch {
    return false
  }
}

export function setArchiveExpanded(expanded: boolean): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(ARCHIVE_EXPANDED_KEY, String(expanded))
  } catch {
    // localStorage might be full or disabled
  }
}
