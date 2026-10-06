// Pure dispatch table for the epic-navigation keyboard handler. Extracted
// from the inline handler in hooks/use-epic-navigation.ts (bb-fe03.3 /
// bb-fe03.2 logical) — the original was CCN 112 in 309 NLOC, well above
// the global standard's refactor threshold (>15).
//
// Each handler returns true when it consumes the event. The orchestrator
// (dispatchKeyDown) chains them in priority order; the first to return
// true short-circuits the rest.
//
// All declarations are arrow form (`const fn = (...) => {...}`) so
// lizard 1.22.1's TypeScript parser correctly identifies function bounds
// for CCN measurement (it groups consecutive `function` declarations into
// one node otherwise — verified in bb-fe03.2 with a 2-fn minimal repro).
//
// Side-effect surface used here that isn't in ctx:
//   - document.querySelector for the search input (gate keys: '/' and Cmd+F)
//   - requestAnimationFrame for focus-on-next-frame after Cmd+F
//   - sessionStorage.getItem/.removeItem for the activity-feed back-nav
// These are deliberately NOT plumbed through ctx because they're stable
// global side-effects and adding them would bloat the context type without
// improving testability — tests stub navigator/document directly when
// they need to.

import type { Bead } from "./types"

export interface NavigableItem {
  id: string
  type: "epic" | "bead"
  bead: Bead
}

export interface KeyNavContext {
  // Read-only state
  focusedItemId: string | null
  navigableItems: NavigableItem[]
  itemIndexMap: Map<string, number>
  expandedEpics: Set<string>
  expandedBeads: Set<string>
  beadIdParam: string | null
  selectedBead: Bead | null
  focusedPanel: "left" | "right"
  settingsOpen: boolean
  filterBarVisible: boolean
  vimEnabled: boolean
  zoomLevel: number
  isTauri: boolean
  hasTrains: boolean

  // Setters / actions
  setFocusedItemId: (id: string | null) => void
  setFocusedPanel: (panel: "left" | "right") => void
  handleToggleEpic: (id: string) => void
  handleToggleBead: (id: string) => void
  handleBeadClick: (bead: Bead) => void
  handleCloseDetail: () => void
  handleRefresh: () => void
  handleZoomChange: (level: number) => void
  onOpenSettings: () => void
  onToggleFilterBar: (visible: boolean) => void
  onMarkAllRead: (beads: Bead[]) => void
  router: { push: (to: string) => void; back: () => void }
  detailNavigateComments: ((direction: "up" | "down") => void) | undefined
  captureShortcut: (shortcut: string, context: "tree" | "detail" | "global") => void

  // Mutable ref state for multi-key sequences (gg)
  lastKey: { key: string; time: number }
  setLastKey: (next: { key: string; time: number }) => void
}

const focusSearchInput = (): void => {
  const searchInput = document.querySelector<HTMLInputElement>("[data-search-input]")
  searchInput?.focus()
}


const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement

const popActivityNavBack = (): boolean => {
  if (sessionStorage.getItem("beadbox-nav-from-activity")) {
    sessionStorage.removeItem("beadbox-nav-from-activity")
    return true
  }
  return false
}

const trySettingsShortcut = (e: KeyboardEvent, ctx: KeyNavContext): boolean => {
  if (e.key !== "," || !(e.metaKey || e.ctrlKey)) return false
  e.preventDefault()
  ctx.onOpenSettings()
  return true
}

const tryFilterBarShortcut = (e: KeyboardEvent, ctx: KeyNavContext): boolean => {
  if (e.key !== "f" || !(e.metaKey || e.ctrlKey) || e.shiftKey) return false
  e.preventDefault()
  const next = !ctx.filterBarVisible
  ctx.onToggleFilterBar(next)
  if (next) requestAnimationFrame(focusSearchInput)
  return true
}

const tryViewSwitchShortcut = (e: KeyboardEvent, ctx: KeyNavContext): boolean => {
  if (!(e.metaKey || e.ctrlKey)) return false
  if (e.key !== "1" && e.key !== "2" && e.key !== "3" && e.key !== "4" && e.key !== "5") return false
  e.preventDefault()
  if (e.key === "2") ctx.router.push("/activity")
  if (e.key === "3") ctx.router.push("/formulas")
  if (e.key === "4" && ctx.hasTrains) ctx.router.push("/trains")
  if (e.key === "5") ctx.router.push("/chart")
  return true
}

const tryRefreshShortcut = (e: KeyboardEvent, ctx: KeyNavContext): boolean => {
  const isCmdR = e.key === "r" && (e.metaKey || e.ctrlKey) && !e.shiftKey
  if (!isCmdR && e.key !== "F5") return false
  e.preventDefault()
  ctx.handleRefresh()
  return true
}

// Cmd+,, Cmd+F, Cmd+1/2/3, Cmd+R, F5. Run before the typing-target gate
// because they should work even from inputs.
export const handleGlobalShortcut = (e: KeyboardEvent, ctx: KeyNavContext): boolean =>
  trySettingsShortcut(e, ctx) ||
  tryFilterBarShortcut(e, ctx) ||
  tryViewSwitchShortcut(e, ctx) ||
  tryRefreshShortcut(e, ctx)

// Cmd+= / Cmd+- / Cmd+0 — Tauri only.
export const handleZoomShortcut = (e: KeyboardEvent, ctx: KeyNavContext): boolean => {
  if (!ctx.isTauri) return false
  if (!(e.metaKey || e.ctrlKey)) return false

  if (e.key === "=" || e.key === "+") {
    e.preventDefault()
    ctx.handleZoomChange(Math.min(200, ctx.zoomLevel + 10))
    return true
  }
  if (e.key === "-") {
    e.preventDefault()
    ctx.handleZoomChange(Math.max(50, ctx.zoomLevel - 10))
    return true
  }
  if (e.key === "0") {
    e.preventDefault()
    ctx.handleZoomChange(100)
    return true
  }
  return false
}

// '/' focuses the search bar. Skip when typing in an input/textarea.
export const handleSlashSearch = (e: KeyboardEvent, ctx: KeyNavContext): boolean => {
  if (e.key !== "/") return false
  if (isTypingTarget(e.target)) return false
  e.preventDefault()
  ctx.captureShortcut("slash", "global")
  focusSearchInput()
  return true
}

const focusLeftPanelFromRight = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  e.preventDefault()
  ctx.setFocusedPanel("left")
}

const navigateDetailComments = (
  e: KeyboardEvent,
  ctx: KeyNavContext,
  direction: "up" | "down",
): void => {
  e.preventDefault()
  ctx.captureShortcut(direction === "down" ? "j" : "k", "detail")
  ctx.detailNavigateComments?.(direction)
}

const escapeRightPanel = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  e.preventDefault()
  ctx.captureShortcut("escape", "detail")
  if (popActivityNavBack()) ctx.router.back()
  else ctx.setFocusedPanel("left")
}

type RightHandler = (e: KeyboardEvent, ctx: KeyNavContext) => void

const NON_VIM_RIGHT_HANDLERS: Record<string, RightHandler | undefined> = {
  ArrowLeft: focusLeftPanelFromRight,
  ArrowDown: (e, ctx) => navigateDetailComments(e, ctx, "down"),
  ArrowUp: (e, ctx) => navigateDetailComments(e, ctx, "up"),
  Escape: escapeRightPanel,
}

const VIM_RIGHT_HANDLERS: Record<string, RightHandler | undefined> = {
  h: focusLeftPanelFromRight,
  j: (e, ctx) => navigateDetailComments(e, ctx, "down"),
  k: (e, ctx) => navigateDetailComments(e, ctx, "up"),
}

// Right-panel keys, only active when focusedPanel='right' && selectedBead.
export const handleRightPanelKey = (e: KeyboardEvent, ctx: KeyNavContext): boolean => {
  const nonVim = NON_VIM_RIGHT_HANDLERS[e.key]
  if (nonVim) {
    nonVim(e, ctx)
    return true
  }
  const vim = ctx.vimEnabled ? VIM_RIGHT_HANDLERS[e.key] : undefined
  if (vim) {
    vim(e, ctx)
    return true
  }
  return false
}

// Left-panel handlers split per concern so each helper sits well below CCN 15.

const moveFocus = (e: KeyboardEvent, ctx: KeyNavContext, direction: "down" | "up"): void => {
  const idx = ctx.focusedItemId ? (ctx.itemIndexMap.get(ctx.focusedItemId) ?? -1) : -1
  e.preventDefault()
  ctx.captureShortcut(direction === "down" ? "j" : "k", "tree")
  if (direction === "down") {
    if (idx < ctx.navigableItems.length - 1) {
      ctx.setFocusedItemId(ctx.navigableItems[idx + 1].id)
    } else if (idx === -1 && ctx.navigableItems.length > 0) {
      ctx.setFocusedItemId(ctx.navigableItems[0].id)
    }
    return
  }
  if (idx > 0) ctx.setFocusedItemId(ctx.navigableItems[idx - 1].id)
}

const expandOrFocusRight = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  e.preventDefault()
  ctx.captureShortcut("l", "tree")
  if (ctx.selectedBead) {
    ctx.setFocusedPanel("right")
    return
  }
  if (!ctx.focusedItemId) return
  const idx = ctx.itemIndexMap.get(ctx.focusedItemId) ?? -1
  const item = ctx.navigableItems[idx]
  if (item?.type === "epic" && !ctx.expandedEpics.has(ctx.focusedItemId)) {
    ctx.handleToggleEpic(ctx.focusedItemId)
  } else if (item?.type === "bead" && !ctx.expandedBeads.has(ctx.focusedItemId)) {
    ctx.handleToggleBead(ctx.focusedItemId)
  }
}

const collapseFocused = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  e.preventDefault()
  ctx.captureShortcut("h", "tree")
  if (!ctx.focusedItemId) return
  const idx = ctx.itemIndexMap.get(ctx.focusedItemId) ?? -1
  const item = ctx.navigableItems[idx]
  if (item?.type === "epic" && ctx.expandedEpics.has(ctx.focusedItemId)) {
    ctx.handleToggleEpic(ctx.focusedItemId)
  } else if (item?.type === "bead" && ctx.expandedBeads.has(ctx.focusedItemId)) {
    ctx.handleToggleBead(ctx.focusedItemId)
  }
}

const activateFocused = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  if (!ctx.focusedItemId) return
  const idx = ctx.itemIndexMap.get(ctx.focusedItemId) ?? -1
  if (idx < 0) return
  e.preventDefault()
  ctx.captureShortcut("enter", "tree")
  ctx.handleBeadClick(ctx.navigableItems[idx].bead)
}

const escapeLeftPanel = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  e.preventDefault()
  ctx.captureShortcut("escape", "global")
  if (ctx.beadIdParam) {
    if (popActivityNavBack()) ctx.router.back()
    else ctx.handleCloseDetail()
    return
  }
  ctx.setFocusedItemId(null)
}

const markAllVisibleRead = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  e.preventDefault()
  ctx.captureShortcut("U", "tree")
  ctx.onMarkAllRead(ctx.navigableItems.map((ni) => ni.bead))
}

const jumpToBottom = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  e.preventDefault()
  ctx.captureShortcut("G", "tree")
  if (ctx.navigableItems.length > 0) {
    ctx.setFocusedItemId(ctx.navigableItems[ctx.navigableItems.length - 1].id)
  }
}

// gg: jump to top, but only when pressed twice within 500ms of itself.
const handleGgSequence = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  const now = Date.now()
  const isFollowupG = ctx.lastKey.key === "g" && now - ctx.lastKey.time < 500
  if (isFollowupG) {
    e.preventDefault()
    ctx.captureShortcut("gg", "tree")
    if (ctx.navigableItems.length > 0) ctx.setFocusedItemId(ctx.navigableItems[0].id)
    ctx.setLastKey({ key: "", time: 0 })
    return
  }
  ctx.setLastKey({ key: "g", time: now })
}

type LeftHandler = (e: KeyboardEvent, ctx: KeyNavContext) => void

// Always-on handlers: keys that work whether or not vim mode is enabled.
const NON_VIM_LEFT_HANDLERS: Record<string, LeftHandler | undefined> = {
  ArrowDown: (e, ctx) => moveFocus(e, ctx, "down"),
  ArrowUp: (e, ctx) => moveFocus(e, ctx, "up"),
  ArrowRight: expandOrFocusRight,
  ArrowLeft: collapseFocused,
  Enter: activateFocused,
  " ": activateFocused,
  Escape: escapeLeftPanel,
  U: markAllVisibleRead,
}

// Vim-only handlers: only fire when ctx.vimEnabled is true.
const VIM_LEFT_HANDLERS: Record<string, LeftHandler | undefined> = {
  j: (e, ctx) => moveFocus(e, ctx, "down"),
  k: (e, ctx) => moveFocus(e, ctx, "up"),
  l: expandOrFocusRight,
  h: collapseFocused,
  G: jumpToBottom,
  g: handleGgSequence,
}

export const handleLeftPanelKey = (e: KeyboardEvent, ctx: KeyNavContext): boolean => {
  const nonVim = NON_VIM_LEFT_HANDLERS[e.key]
  if (nonVim) {
    nonVim(e, ctx)
    return true
  }
  const vim = ctx.vimEnabled ? VIM_LEFT_HANDLERS[e.key] : undefined
  if (vim) {
    vim(e, ctx)
    return true
  }
  return false
}

// Top-level orchestrator. Mirrors the original handleKeyDown's gate order
// exactly: global+zoom shortcuts run before the typing-target gate (they
// must work from inside inputs); '/' search runs after the input gate.
export const dispatchKeyDown = (e: KeyboardEvent, ctx: KeyNavContext): void => {
  if (handleGlobalShortcut(e, ctx)) return
  if (handleZoomShortcut(e, ctx)) return
  if (handleSlashSearch(e, ctx)) return

  if (isTypingTarget(e.target)) return
  if (ctx.settingsOpen) return

  if (ctx.focusedPanel === "right" && ctx.selectedBead) {
    handleRightPanelKey(e, ctx)
    return
  }

  handleLeftPanelKey(e, ctx)
}
