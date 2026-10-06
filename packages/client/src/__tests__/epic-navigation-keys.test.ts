// Unit tests for lib/epic-navigation-keys.ts (bb-fe03.3 / bb-fe03.2 logical).
//
// Tests-first per parent bead AC. The original handleKeyDown was 309 NLOC
// at CCN 112 — far too complex to unit-test as-is. Splitting into pure
// dispatch fns lets each branch get explicit coverage.
//
// Strategy: build a stub KeyNavContext with mock fns, fire a synthetic
// KeyboardEvent, and assert (a) the right ctx fns were called with the
// right args, (b) preventDefault was called when handled, (c) handlers
// return true/false correctly so the orchestrator can chain.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  dispatchKeyDown,
  handleGlobalShortcut,
  handleLeftPanelKey,
  handleRightPanelKey,
  handleSlashSearch,
  handleZoomShortcut,
  type KeyNavContext,
  type NavigableItem,
} from "../lib/epic-navigation-keys"
import type { Bead } from "../lib/types"

// bb-fjlv: this file used to spin up its own happy-dom Window and overwrite
// globalThis.document, which broke bun:test's hook registration for downstream
// files (rc.8 retry — custom-statuses-manager hit cross-file DOM leak). All
// DOM globals now come from _test-globals.ts's shared Window.

const makeBead = (id: string): Bead =>
  ({
    id,
    title: `Bead ${id}`,
    status: "open",
    priority: 2,
    type: "task",
  }) as unknown as Bead

const makeItems = (ids: Array<{ id: string; type: "epic" | "bead" }>): NavigableItem[] =>
  ids.map((x) => ({ id: x.id, type: x.type, bead: makeBead(x.id) }))

const makeIndex = (items: NavigableItem[]): Map<string, number> =>
  new Map(items.map((it, i) => [it.id, i]))

const makeCtx = (overrides: Partial<KeyNavContext> = {}): KeyNavContext => {
  const items = makeItems([
    { id: "e1", type: "epic" },
    { id: "b1", type: "bead" },
    { id: "b2", type: "bead" },
  ])
  return {
    focusedItemId: null,
    navigableItems: items,
    itemIndexMap: makeIndex(items),
    expandedEpics: new Set(),
    expandedBeads: new Set(),
    beadIdParam: null,
    selectedBead: null,
    focusedPanel: "left",
    settingsOpen: false,
    filterBarVisible: false,
    vimEnabled: false,
    zoomLevel: 100,
    isTauri: false,
    hasTrains: false,
    setFocusedItemId: mock(() => {}),
    setFocusedPanel: mock(() => {}),
    handleToggleEpic: mock(() => {}),
    handleToggleBead: mock(() => {}),
    handleBeadClick: mock(() => {}),
    handleCloseDetail: mock(() => {}),
    handleRefresh: mock(() => {}),
    handleZoomChange: mock(() => {}),
    onOpenSettings: mock(() => {}),
    onToggleFilterBar: mock(() => {}),
    onMarkAllRead: mock(() => {}),
    router: { push: mock(() => {}), back: mock(() => {}) },
    detailNavigateComments: mock(() => {}),
    captureShortcut: mock(() => {}),
    lastKey: { key: "", time: 0 },
    setLastKey: mock(() => {}),
    ...overrides,
  }
}

const fireKey = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new (window.KeyboardEvent as unknown as typeof KeyboardEvent)("keydown", {
    key,
    ...init,
  })

const ensureSearchInput = (): HTMLInputElement => {
  const existing = window.document.querySelector("input[data-search-input]")
  if (existing) return existing as unknown as HTMLInputElement
  const input = window.document.createElement("input")
  input.setAttribute("data-search-input", "")
  // biome-ignore lint/suspicious/noExplicitAny: happy-dom Node vs DOM Node mismatch only at the type level.
  window.document.body.appendChild(input as any)
  return input as unknown as HTMLInputElement
}

beforeEach(() => {
  // Reset DOM safely without innerHTML (XSS-safe; the data-search-input is the
  // single fixture every test needs).
  while (window.document.body.firstChild) {
    window.document.body.removeChild(window.document.body.firstChild)
  }
  ensureSearchInput()
  window.sessionStorage.clear()
  window.localStorage.clear()
  // beadbox-l5i.1: isFeatureEnabled resolves env -> localStorage -> PostHog.
  // Clear the process-global env override so the Cmd+3 tests below actually
  // exercise the localStorage path they claim to, regardless of which files
  // ran before this one.
  delete (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_BEADBOX_FLAG_OVERRIDE
})

afterEach(() => {
  // bb-fjlv: remove the data-search-input fixture appended by ensureSearchInput()
  // so it doesn't leak into other test files that share globalThis.document
  // (see _test-globals.ts — single Window across the whole process).
  while (window.document.body.firstChild) {
    window.document.body.removeChild(window.document.body.firstChild)
  }
  window.sessionStorage.clear()
  window.localStorage.clear()
  // beadbox-l5i.1: isFeatureEnabled resolves env -> localStorage -> PostHog.
  // Clear the process-global env override so the Cmd+3 tests below actually
  // exercise the localStorage path they claim to, regardless of which files
  // ran before this one.
  delete (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_BEADBOX_FLAG_OVERRIDE
})

describe("handleGlobalShortcut", () => {
  test("Cmd+, opens settings and consumes event", () => {
    const ctx = makeCtx()
    const e = fireKey(",", { metaKey: true })
    const prevent = mock(() => {})
    Object.defineProperty(e, "preventDefault", { value: prevent })
    expect(handleGlobalShortcut(e, ctx)).toBe(true)
    expect(prevent).toHaveBeenCalledTimes(1)
    expect(ctx.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  test("Ctrl+, also opens settings (Windows/Linux)", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey(",", { ctrlKey: true }), ctx)).toBe(true)
    expect(ctx.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  test("Cmd+F toggles filter bar; opening focuses search input", () => {
    const ctx = makeCtx({ filterBarVisible: false })
    expect(handleGlobalShortcut(fireKey("f", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.onToggleFilterBar).toHaveBeenCalledWith(true)
  })

  test("Cmd+F when filter bar visible toggles off (no focus call)", () => {
    const ctx = makeCtx({ filterBarVisible: true })
    expect(handleGlobalShortcut(fireKey("f", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.onToggleFilterBar).toHaveBeenCalledWith(false)
  })

  test("Cmd+Shift+F is NOT consumed (different shortcut elsewhere)", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey("f", { metaKey: true, shiftKey: true }), ctx)).toBe(false)
    expect(ctx.onToggleFilterBar).not.toHaveBeenCalled()
  })

  test("Cmd+1 consumes but does not navigate (default = beads view)", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey("1", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.router.push).not.toHaveBeenCalled()
  })

  test("Cmd+2 navigates to /activity", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey("2", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.router.push).toHaveBeenCalledWith("/activity")
  })

  test("Cmd+3 navigates to /formulas with no override and no PostHog (beadbox-01f.1)", () => {
    // Formulas is GA: the route is unconditional. This is the bead's AC-2 in
    // unit form -- nothing set in localStorage, no env override surviving
    // beforeEach, and PostHog uninitialised here. Before the flag was removed
    // this exact state routed NOWHERE, which is how the feature came to be off
    // for most users by accident rather than by decision.
    const ctx = makeCtx()
    expect(window.localStorage.getItem("beadbox_flag_overrides")).toBeNull()
    expect(handleGlobalShortcut(fireKey("3", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.router.push).toHaveBeenCalledWith("/formulas")
  })

  test("Cmd+4 navigates to /trains when the workspace has plans", () => {
    const ctx = makeCtx({ hasTrains: true })
    expect(handleGlobalShortcut(fireKey("4", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.router.push).toHaveBeenCalledWith("/trains")
  })

  test("Cmd+5 navigates to /chart (beadbox-eic)", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey("5", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.router.push).toHaveBeenCalledWith("/chart")
  })

  test("Cmd+4 does nothing when the workspace has no plans (zero footprint)", () => {
    const ctx = makeCtx({ hasTrains: false })
    handleGlobalShortcut(fireKey("4", { metaKey: true }), ctx)
    expect(ctx.router.push).not.toHaveBeenCalledWith("/trains")
  })

  test("a stale flag override can no longer suppress Cmd+3 (beadbox-01f.1)", () => {
    // Anyone who set the escape-hatch override while Formulas was gated still
    // has it in localStorage. The route no longer consults any flag, so a
    // leftover false must not hide a GA feature. Deleting the branch rather
    // than defaulting the flag true is what makes this hold.
    const ctx = makeCtx()
    window.localStorage.setItem(
      "beadbox_flag_overrides",
      JSON.stringify({ "formulas-legacy-override": false }),
    )
    expect(handleGlobalShortcut(fireKey("3", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.router.push).toHaveBeenCalledWith("/formulas")
    window.localStorage.removeItem("beadbox_flag_overrides")
  })

  test("Cmd+R refreshes", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey("r", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.handleRefresh).toHaveBeenCalledTimes(1)
  })

  test("F5 refreshes", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey("F5"), ctx)).toBe(true)
    expect(ctx.handleRefresh).toHaveBeenCalledTimes(1)
  })

  test("Cmd+Shift+R is NOT consumed (browser hard reload reserved)", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey("r", { metaKey: true, shiftKey: true }), ctx)).toBe(false)
  })

  test("plain 'r' is NOT consumed", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey("r"), ctx)).toBe(false)
  })

  test("returns false on unhandled key", () => {
    const ctx = makeCtx()
    expect(handleGlobalShortcut(fireKey("x"), ctx)).toBe(false)
  })
})

describe("handleZoomShortcut", () => {
  test("returns false when not Tauri", () => {
    const ctx = makeCtx({ isTauri: false })
    expect(handleZoomShortcut(fireKey("=", { metaKey: true }), ctx)).toBe(false)
    expect(ctx.handleZoomChange).not.toHaveBeenCalled()
  })

  test("returns false when no Cmd/Ctrl modifier", () => {
    const ctx = makeCtx({ isTauri: true })
    expect(handleZoomShortcut(fireKey("="), ctx)).toBe(false)
  })

  test("Cmd+= zooms in by 10", () => {
    const ctx = makeCtx({ isTauri: true, zoomLevel: 100 })
    expect(handleZoomShortcut(fireKey("=", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.handleZoomChange).toHaveBeenCalledWith(110)
  })

  test("Cmd++ also zooms in (some keyboards report '+' instead of '=')", () => {
    const ctx = makeCtx({ isTauri: true, zoomLevel: 100 })
    expect(handleZoomShortcut(fireKey("+", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.handleZoomChange).toHaveBeenCalledWith(110)
  })

  test("Cmd+= clamps at 200", () => {
    const ctx = makeCtx({ isTauri: true, zoomLevel: 195 })
    handleZoomShortcut(fireKey("=", { metaKey: true }), ctx)
    expect(ctx.handleZoomChange).toHaveBeenCalledWith(200)
  })

  test("Cmd+- zooms out by 10", () => {
    const ctx = makeCtx({ isTauri: true, zoomLevel: 100 })
    expect(handleZoomShortcut(fireKey("-", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.handleZoomChange).toHaveBeenCalledWith(90)
  })

  test("Cmd+- clamps at 50", () => {
    const ctx = makeCtx({ isTauri: true, zoomLevel: 55 })
    handleZoomShortcut(fireKey("-", { metaKey: true }), ctx)
    expect(ctx.handleZoomChange).toHaveBeenCalledWith(50)
  })

  test("Cmd+0 resets to 100", () => {
    const ctx = makeCtx({ isTauri: true, zoomLevel: 145 })
    expect(handleZoomShortcut(fireKey("0", { metaKey: true }), ctx)).toBe(true)
    expect(ctx.handleZoomChange).toHaveBeenCalledWith(100)
  })

  test("returns false on unrelated key", () => {
    const ctx = makeCtx({ isTauri: true })
    expect(handleZoomShortcut(fireKey("z", { metaKey: true }), ctx)).toBe(false)
  })
})

describe("handleSlashSearch", () => {
  test("'/' consumes and fires shortcut analytics + focuses search", () => {
    const ctx = makeCtx()
    expect(handleSlashSearch(fireKey("/"), ctx)).toBe(true)
    expect(ctx.captureShortcut).toHaveBeenCalledWith("slash", "global")
  })

  test("'/' inside an input is NOT consumed", () => {
    const ctx = makeCtx()
    const e = fireKey("/")
    Object.defineProperty(e, "target", { value: ensureSearchInput() })
    expect(handleSlashSearch(e, ctx)).toBe(false)
  })

  test("returns false on non-slash", () => {
    const ctx = makeCtx()
    expect(handleSlashSearch(fireKey("a"), ctx)).toBe(false)
  })
})

describe("handleRightPanelKey", () => {
  test("ArrowLeft switches focus to left panel", () => {
    const ctx = makeCtx()
    expect(handleRightPanelKey(fireKey("ArrowLeft"), ctx)).toBe(true)
    expect(ctx.setFocusedPanel).toHaveBeenCalledWith("left")
  })

  test("h with vim enabled switches focus to left panel", () => {
    const ctx = makeCtx({ vimEnabled: true })
    expect(handleRightPanelKey(fireKey("h"), ctx)).toBe(true)
    expect(ctx.setFocusedPanel).toHaveBeenCalledWith("left")
  })

  test("h without vim returns false", () => {
    const ctx = makeCtx({ vimEnabled: false })
    expect(handleRightPanelKey(fireKey("h"), ctx)).toBe(false)
    expect(ctx.setFocusedPanel).not.toHaveBeenCalled()
  })

  test("ArrowDown navigates comments down", () => {
    const ctx = makeCtx()
    expect(handleRightPanelKey(fireKey("ArrowDown"), ctx)).toBe(true)
    expect(ctx.detailNavigateComments).toHaveBeenCalledWith("down")
  })

  test("ArrowUp navigates comments up", () => {
    const ctx = makeCtx()
    expect(handleRightPanelKey(fireKey("ArrowUp"), ctx)).toBe(true)
    expect(ctx.detailNavigateComments).toHaveBeenCalledWith("up")
  })

  test("j/k vim only when vim enabled", () => {
    const ctx = makeCtx({ vimEnabled: true })
    handleRightPanelKey(fireKey("j"), ctx)
    handleRightPanelKey(fireKey("k"), ctx)
    expect(ctx.detailNavigateComments).toHaveBeenCalledWith("down")
    expect(ctx.detailNavigateComments).toHaveBeenCalledWith("up")
  })

  test("Escape returns to left panel when no activity-feed back marker", () => {
    const ctx = makeCtx()
    expect(handleRightPanelKey(fireKey("Escape"), ctx)).toBe(true)
    expect(ctx.setFocusedPanel).toHaveBeenCalledWith("left")
    expect(ctx.router.back).not.toHaveBeenCalled()
  })

  test("Escape returns to activity feed when back marker present", () => {
    window.sessionStorage.setItem("beadbox-nav-from-activity", "1")
    const ctx = makeCtx()
    handleRightPanelKey(fireKey("Escape"), ctx)
    expect(ctx.router.back).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem("beadbox-nav-from-activity")).toBeNull()
  })

  test("returns false on unhandled key", () => {
    const ctx = makeCtx()
    expect(handleRightPanelKey(fireKey("x"), ctx)).toBe(false)
  })
})

describe("handleLeftPanelKey", () => {
  test("ArrowDown advances focus", () => {
    const ctx = makeCtx({ focusedItemId: "e1" })
    expect(handleLeftPanelKey(fireKey("ArrowDown"), ctx)).toBe(true)
    expect(ctx.setFocusedItemId).toHaveBeenCalledWith("b1")
  })

  test("ArrowDown from no focus selects first item", () => {
    const ctx = makeCtx({ focusedItemId: null })
    handleLeftPanelKey(fireKey("ArrowDown"), ctx)
    expect(ctx.setFocusedItemId).toHaveBeenCalledWith("e1")
  })

  test("ArrowDown at end of list does not advance past last", () => {
    const ctx = makeCtx({ focusedItemId: "b2" })
    handleLeftPanelKey(fireKey("ArrowDown"), ctx)
    expect(ctx.setFocusedItemId).not.toHaveBeenCalled()
  })

  test("ArrowUp moves focus back", () => {
    const ctx = makeCtx({ focusedItemId: "b1" })
    handleLeftPanelKey(fireKey("ArrowUp"), ctx)
    expect(ctx.setFocusedItemId).toHaveBeenCalledWith("e1")
  })

  test("j/k disabled without vim", () => {
    const ctx = makeCtx({ focusedItemId: "e1", vimEnabled: false })
    expect(handleLeftPanelKey(fireKey("j"), ctx)).toBe(false)
    expect(handleLeftPanelKey(fireKey("k"), ctx)).toBe(false)
  })

  test("j with vim moves focus down", () => {
    const ctx = makeCtx({ focusedItemId: "e1", vimEnabled: true })
    handleLeftPanelKey(fireKey("j"), ctx)
    expect(ctx.setFocusedItemId).toHaveBeenCalledWith("b1")
  })

  test("ArrowRight switches to right panel when bead is selected", () => {
    const ctx = makeCtx({ selectedBead: makeBead("b1") })
    handleLeftPanelKey(fireKey("ArrowRight"), ctx)
    expect(ctx.setFocusedPanel).toHaveBeenCalledWith("right")
  })

  test("ArrowRight expands a focused collapsed epic", () => {
    const ctx = makeCtx({ focusedItemId: "e1" })
    handleLeftPanelKey(fireKey("ArrowRight"), ctx)
    expect(ctx.handleToggleEpic).toHaveBeenCalledWith("e1")
  })

  test("ArrowRight does NOT toggle an already-expanded epic", () => {
    const ctx = makeCtx({
      focusedItemId: "e1",
      expandedEpics: new Set(["e1"]),
    })
    handleLeftPanelKey(fireKey("ArrowRight"), ctx)
    expect(ctx.handleToggleEpic).not.toHaveBeenCalled()
  })

  test("ArrowRight expands a focused bead with subtasks", () => {
    const ctx = makeCtx({ focusedItemId: "b1" })
    handleLeftPanelKey(fireKey("ArrowRight"), ctx)
    expect(ctx.handleToggleBead).toHaveBeenCalledWith("b1")
  })

  test("ArrowLeft collapses a focused expanded epic", () => {
    const ctx = makeCtx({
      focusedItemId: "e1",
      expandedEpics: new Set(["e1"]),
    })
    handleLeftPanelKey(fireKey("ArrowLeft"), ctx)
    expect(ctx.handleToggleEpic).toHaveBeenCalledWith("e1")
  })

  test("ArrowLeft does NOT toggle an already-collapsed epic", () => {
    const ctx = makeCtx({ focusedItemId: "e1", expandedEpics: new Set() })
    handleLeftPanelKey(fireKey("ArrowLeft"), ctx)
    expect(ctx.handleToggleEpic).not.toHaveBeenCalled()
  })

  test("Enter activates the focused item", () => {
    const ctx = makeCtx({ focusedItemId: "b1" })
    handleLeftPanelKey(fireKey("Enter"), ctx)
    expect(ctx.handleBeadClick).toHaveBeenCalledTimes(1)
  })

  test("Space activates the focused item", () => {
    const ctx = makeCtx({ focusedItemId: "b1" })
    handleLeftPanelKey(fireKey(" "), ctx)
    expect(ctx.handleBeadClick).toHaveBeenCalledTimes(1)
  })

  test("Enter with no focus is a no-op", () => {
    const ctx = makeCtx({ focusedItemId: null })
    handleLeftPanelKey(fireKey("Enter"), ctx)
    expect(ctx.handleBeadClick).not.toHaveBeenCalled()
  })

  test("Escape closes detail when bead URL param set", () => {
    const ctx = makeCtx({ beadIdParam: "b1" })
    handleLeftPanelKey(fireKey("Escape"), ctx)
    expect(ctx.handleCloseDetail).toHaveBeenCalledTimes(1)
  })

  test("Escape returns to activity feed when back marker present", () => {
    window.sessionStorage.setItem("beadbox-nav-from-activity", "1")
    const ctx = makeCtx({ beadIdParam: "b1" })
    handleLeftPanelKey(fireKey("Escape"), ctx)
    expect(ctx.router.back).toHaveBeenCalledTimes(1)
    expect(ctx.handleCloseDetail).not.toHaveBeenCalled()
  })

  test("Escape clears focus when no bead param", () => {
    const ctx = makeCtx({ beadIdParam: null, focusedItemId: "e1" })
    handleLeftPanelKey(fireKey("Escape"), ctx)
    expect(ctx.setFocusedItemId).toHaveBeenCalledWith(null)
  })

  test("Shift+U marks all visible beads as read", () => {
    const ctx = makeCtx()
    handleLeftPanelKey(fireKey("U"), ctx)
    expect(ctx.onMarkAllRead).toHaveBeenCalledTimes(1)
    const calls = (ctx.onMarkAllRead as ReturnType<typeof mock>).mock.calls
    expect(calls[0][0]).toHaveLength(3)
  })

  test("Shift+G with vim jumps to bottom", () => {
    const ctx = makeCtx({ vimEnabled: true })
    handleLeftPanelKey(fireKey("G"), ctx)
    expect(ctx.setFocusedItemId).toHaveBeenCalledWith("b2")
  })

  test("Shift+G without vim returns false", () => {
    const ctx = makeCtx({ vimEnabled: false })
    expect(handleLeftPanelKey(fireKey("G"), ctx)).toBe(false)
  })

  test("first 'g' arms the gg sequence", () => {
    const ctx = makeCtx({ vimEnabled: true, lastKey: { key: "", time: 0 } })
    handleLeftPanelKey(fireKey("g"), ctx)
    expect(ctx.setLastKey).toHaveBeenCalledTimes(1)
    const newKey = (ctx.setLastKey as ReturnType<typeof mock>).mock.calls[0][0]
    expect(newKey.key).toBe("g")
    expect(ctx.setFocusedItemId).not.toHaveBeenCalled()
  })

  test("second 'g' within 500ms jumps to top and resets sequence", () => {
    const ctx = makeCtx({
      vimEnabled: true,
      lastKey: { key: "g", time: Date.now() - 100 },
    })
    handleLeftPanelKey(fireKey("g"), ctx)
    expect(ctx.setFocusedItemId).toHaveBeenCalledWith("e1")
    expect(ctx.setLastKey).toHaveBeenCalledWith({ key: "", time: 0 })
  })

  test("'g' more than 500ms after first 'g' just re-arms (does not jump)", () => {
    const ctx = makeCtx({
      vimEnabled: true,
      lastKey: { key: "g", time: Date.now() - 1000 },
    })
    handleLeftPanelKey(fireKey("g"), ctx)
    expect(ctx.setFocusedItemId).not.toHaveBeenCalled()
    const newKey = (ctx.setLastKey as ReturnType<typeof mock>).mock.calls[0][0]
    expect(newKey.key).toBe("g")
  })

  test("returns false on unhandled key", () => {
    const ctx = makeCtx()
    expect(handleLeftPanelKey(fireKey("z"), ctx)).toBe(false)
  })
})

describe("dispatchKeyDown (orchestrator)", () => {
  test("global shortcut runs even when focused inside an input", () => {
    const ctx = makeCtx()
    const e = fireKey(",", { metaKey: true })
    Object.defineProperty(e, "target", { value: ensureSearchInput() })
    dispatchKeyDown(e, ctx)
    expect(ctx.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  test("typing target gates left/right-panel keys", () => {
    const ctx = makeCtx({ focusedItemId: "e1" })
    const e = fireKey("ArrowDown")
    Object.defineProperty(e, "target", { value: ensureSearchInput() })
    dispatchKeyDown(e, ctx)
    expect(ctx.setFocusedItemId).not.toHaveBeenCalled()
  })

  test("settingsOpen gates panel keys", () => {
    const ctx = makeCtx({ focusedItemId: "e1", settingsOpen: true })
    dispatchKeyDown(fireKey("ArrowDown"), ctx)
    expect(ctx.setFocusedItemId).not.toHaveBeenCalled()
  })

  test("right-panel key path active only when focusedPanel='right' AND selectedBead", () => {
    const ctx = makeCtx({
      focusedPanel: "right",
      selectedBead: makeBead("b1"),
    })
    dispatchKeyDown(fireKey("ArrowDown"), ctx)
    expect(ctx.detailNavigateComments).toHaveBeenCalledWith("down")
    expect(ctx.setFocusedItemId).not.toHaveBeenCalled()
  })

  test("right-panel path skipped when no selectedBead", () => {
    const ctx = makeCtx({ focusedPanel: "right", selectedBead: null, focusedItemId: "e1" })
    dispatchKeyDown(fireKey("ArrowDown"), ctx)
    expect(ctx.detailNavigateComments).not.toHaveBeenCalled()
    expect(ctx.setFocusedItemId).toHaveBeenCalledWith("b1")
  })

  test("left-panel path is the default", () => {
    const ctx = makeCtx({ focusedItemId: "e1" })
    dispatchKeyDown(fireKey("ArrowDown"), ctx)
    expect(ctx.setFocusedItemId).toHaveBeenCalledWith("b1")
  })

  test("zoom shortcut runs even from inputs (Tauri zoom from anywhere)", () => {
    const ctx = makeCtx({ isTauri: true, zoomLevel: 100 })
    const e = fireKey("=", { metaKey: true })
    Object.defineProperty(e, "target", { value: ensureSearchInput() })
    dispatchKeyDown(e, ctx)
    expect(ctx.handleZoomChange).toHaveBeenCalledWith(110)
  })

  test("'/' search runs from non-input but is gated by typing target", () => {
    const ctx = makeCtx()
    const e = fireKey("/")
    Object.defineProperty(e, "target", { value: ensureSearchInput() })
    dispatchKeyDown(e, ctx)
    expect(ctx.captureShortcut).not.toHaveBeenCalled()
  })
})
