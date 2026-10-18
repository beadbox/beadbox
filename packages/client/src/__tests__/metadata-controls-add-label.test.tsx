// beadbox-m4i (GitHub #57): add a label from the detail panel.
//
// The metadata row could remove a label (the chip's "x") but not add one, and
// rendered no labels area at all for an unlabelled bead. These tests pin the
// "+" control: present without labels, reachable and usable by keyboard, the
// same inline-input pattern as the assignee "Add new..." input, and the input
// rules bd itself implies (it splits on commas, and a leading dash is a flag to
// `bd label`). The hook test pins the optimistic add and its rollback.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { act, cleanup, render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

// Namespace import: a missing export then fails only the test that uses it,
// instead of failing the whole file at load.
import * as helpers from "../components/bead-detail-helpers"
import { MetadataControls } from "../components/bead-metadata-controls"
import { TooltipProvider } from "../components/ui/tooltip"
import { useBeadMutations } from "../hooks/use-bead-mutations"
import { dispatchKeyDown, type KeyNavContext } from "../lib/epic-navigation-keys"
import { extractLabels } from "../lib/epic-tree-utils"
import type { Bead, Epic } from "../lib/types"

afterEach(cleanup)

const user = () => userEvent.setup({ delay: null })

function renderControls(over: { labels?: string[]; availableLabels?: string[] } = {}) {
  const onAddLabel = mock((_label: string) => {})
  const onRemoveLabel = mock((_label: string) => {})
  render(
    <TooltipProvider>
      <MetadataControls
        status="open"
        priority="medium"
        assignee=""
        labels={over.labels ?? []}
        availableLabels={over.availableLabels ?? []}
        availableStatuses={["open", "in_progress", "closed"]}
        assignees={[]}
        fieldStates={{
          status: helpers.initialFieldStates.status,
          priority: helpers.initialFieldStates.priority,
          assignee: helpers.initialFieldStates.assignee,
        }}
        onStatusChange={() => {}}
        onPriorityChange={() => {}}
        onAssigneeChange={() => {}}
        onAddLabel={onAddLabel}
        onRemoveLabel={onRemoveLabel}
        isMobile={false}
      />
    </TooltipProvider>,
  )
  return { onAddLabel, onRemoveLabel }
}

describe("detail panel Add label control (beadbox-m4i)", () => {
  test("an unlabelled bead still shows the + control", () => {
    renderControls({ labels: [] })
    expect(screen.getByRole("button", { name: "Add label" })).toBeTruthy()
  })

  test("the + sits after the existing labels", () => {
    renderControls({ labels: ["ui"] })
    expect(screen.getByText("ui")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add label" })).toBeTruthy()
  })

  test("keyboard: Tab reaches +, Enter opens the input, typing + Enter adds", async () => {
    const u = user()
    const { onAddLabel } = renderControls({ labels: [] })
    const plus = screen.getByRole("button", { name: "Add label" })
    // Tab through the row until the + has focus; it must be reachable.
    for (let i = 0; i < 10 && document.activeElement !== plus; i++) await u.tab()
    expect(document.activeElement).toBe(plus)
    await u.keyboard("{Enter}")
    const input = screen.getByRole("combobox", { name: "New label" })
    expect(document.activeElement).toBe(input)
    await u.keyboard("needs-review{Enter}")
    expect(onAddLabel).toHaveBeenCalledTimes(1)
    expect(onAddLabel).toHaveBeenCalledWith("needs-review")
    // The input closes and focus goes back to the +.
    expect(screen.queryByRole("combobox", { name: "New label" })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add label" }))
  })

  test("Escape cancels without adding", async () => {
    const u = user()
    const { onAddLabel } = renderControls()
    await u.click(screen.getByRole("button", { name: "Add label" }))
    await u.keyboard("abandoned{Escape}")
    expect(onAddLabel).not.toHaveBeenCalled()
    expect(screen.queryByRole("combobox", { name: "New label" })).toBeNull()
  })

  test.each([
    ["blank", "   "],
    ["duplicate", "ui"],
    ["comma (bd splits it)", "a,b"],
    ["leading dash", "-x"],
  ])("%s input is ignored", async (_name, typed) => {
    const u = user()
    const { onAddLabel } = renderControls({ labels: ["ui"] })
    await u.click(screen.getByRole("button", { name: "Add label" }))
    await u.keyboard(`${typed}{Enter}`)
    expect(onAddLabel).not.toHaveBeenCalled()
    // Ignored, not cancelled: the input stays open for a correction.
    expect(screen.getByRole("combobox", { name: "New label" })).toBeTruthy()
  })

  test("the input does not autocorrect or capitalise what is typed", async () => {
    // Found on the real app: macOS offered "Needs-review" for "needs-review".
    // Accepting it would write a different label to bd than the one typed.
    const u = user()
    renderControls()
    await u.click(screen.getByRole("button", { name: "Add label" }))
    const input = screen.getByRole("combobox", { name: "New label" })
    expect(input.getAttribute("autocorrect")).toBe("off")
    expect(input.getAttribute("autocapitalize")).toBe("off")
    expect(input.getAttribute("spellcheck")).toBe("false")
  })

  test("suggests the workspace's labels that the bead does not have", async () => {
    const u = user()
    renderControls({ labels: ["ui"], availableLabels: ["backend", "ui", "docs"] })
    await u.click(screen.getByRole("button", { name: "Add label" }))
    const input = screen.getByRole("combobox", { name: "New label" })
    const list = document.getElementById(input.getAttribute("list") ?? "")
    expect(list).toBeTruthy()
    const options = Array.from(list?.querySelectorAll("option") ?? []).map((o) => o.value)
    expect(options).toEqual(["backend", "docs"])
  })
})

describe("normalizeNewLabel", () => {
  test("trims, and refuses blank, comma, leading dash and duplicates", () => {
    expect(helpers.normalizeNewLabel("  ship-it ", [])).toBe("ship-it")
    expect(helpers.normalizeNewLabel("has space", [])).toBe("has space")
    expect(helpers.normalizeNewLabel("", [])).toBeNull()
    expect(helpers.normalizeNewLabel("   ", [])).toBeNull()
    expect(helpers.normalizeNewLabel("a,b", [])).toBeNull()
    expect(helpers.normalizeNewLabel("-flag", [])).toBeNull()
    expect(helpers.normalizeNewLabel(" ui ", ["ui"])).toBeNull()
  })
})

describe("useBeadMutations.handleAddLabel", () => {
  const bead = {
    id: "t-1",
    title: "t",
    type: "task",
    status: "open",
    priority: "medium",
    labels: [],
    comments: [],
  } as unknown as Bead

  test("adds optimistically, then rolls back with a toast when the write throws", async () => {
    // No sidecar under test, so every rpc call throws RpcUnavailableError: the
    // same shape as a sidecar deadline or restart mid-call.
    const errorToast = spyOn(toast, "error").mockImplementation(() => "")
    try {
      const onUpdate = mock((_b: Bead) => {})
      const { result } = renderHook(() => useBeadMutations({ bead, onUpdate }))
      let pending: Promise<void> = Promise.resolve()
      act(() => {
        pending = result.current.handleAddLabel("fresh")
      })
      expect(result.current.labels).toEqual(["fresh"])
      await act(async () => {
        await pending
      })
      expect(result.current.labels).toEqual([])
      expect(onUpdate).not.toHaveBeenCalled()
      expect(errorToast).toHaveBeenCalledTimes(1)
      expect(errorToast.mock.calls[0][0]).toBe("Failed to add label")
    } finally {
      errorToast.mockRestore()
    }
  })

  test("ignores invalid text without writing", async () => {
    const errorToast = spyOn(toast, "error").mockImplementation(() => "")
    try {
      const { result } = renderHook(() => useBeadMutations({ bead, onUpdate: () => {} }))
      await act(async () => {
        await result.current.handleAddLabel("a,b")
      })
      expect(result.current.labels).toEqual([])
      expect(errorToast).not.toHaveBeenCalled()
    } finally {
      errorToast.mockRestore()
    }
  })
})

describe("extractLabels", () => {
  test("collects unique labels from epics, children and child epics, sorted", () => {
    const epics = [
      {
        id: "e1",
        labels: ["ui", "release"],
        children: [{ id: "b1", labels: ["backend", "ui"], children: [] }],
        childEpics: [{ id: "e2", labels: ["docs"], children: [], childEpics: [] }],
      },
      { id: "e3", children: [], childEpics: [] },
    ] as unknown as Epic[]
    expect(extractLabels(epics)).toEqual(["backend", "docs", "release", "ui"])
  })
})

// Found on the real app (.207): the tree's global keydown handler
// (dispatchKeyDown on window) only steps aside for inputs and textareas. With a
// tree item focused it maps Enter and Space to "open the focused bead" and calls
// preventDefault, which cancels the + button's own activation. Install the real
// dispatcher, in the state the app was in, and press the keys on the +.
describe("Add label with the tree's keyboard navigation mounted", () => {
  const items = [{ id: "t-1", type: "bead" as const, bead: { id: "t-1" } as unknown as Bead }]
  const handleBeadClick = mock((_b: Bead) => {})
  const ctx = {
    focusedItemId: "t-1",
    navigableItems: items,
    itemIndexMap: new Map([["t-1", 0]]),
    expandedEpics: new Set<string>(),
    expandedBeads: new Set<string>(),
    beadIdParam: null,
    selectedBead: null,
    focusedPanel: "left",
    settingsOpen: false,
    filterBarVisible: false,
    vimEnabled: false,
    zoomLevel: 100,
    isTauri: false,
    hasTrains: false,
    setFocusedItemId: () => {},
    setFocusedPanel: () => {},
    handleToggleEpic: () => {},
    handleToggleBead: () => {},
    handleBeadClick,
    handleCloseDetail: () => {},
    handleRefresh: () => {},
    handleZoomChange: () => {},
    onOpenSettings: () => {},
    onToggleFilterBar: () => {},
    onMarkAllRead: () => {},
    router: { push: () => {}, back: () => {} },
    detailNavigateComments: () => {},
    captureShortcut: () => {},
    lastKey: { key: "", time: 0 },
    setLastKey: () => {},
  } as unknown as KeyNavContext
  const onKey = (e: KeyboardEvent) => dispatchKeyDown(e, ctx)

  beforeEach(() => {
    handleBeadClick.mockClear()
    window.addEventListener("keydown", onKey)
  })
  afterEach(() => window.removeEventListener("keydown", onKey))

  test.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("%s on the + opens the input", async (_k, key) => {
    const u = user()
    renderControls()
    screen.getByRole("button", { name: "Add label" }).focus()
    await u.keyboard(key)
    expect(screen.getByRole("combobox", { name: "New label" })).toBeTruthy()
    expect(handleBeadClick).not.toHaveBeenCalled()
  })

  test("typing a label and Enter adds it, without the tree reacting", async () => {
    const u = user()
    const { onAddLabel } = renderControls()
    screen.getByRole("button", { name: "Add label" }).focus()
    await u.keyboard("{Enter}needs-review{Enter}")
    expect(onAddLabel).toHaveBeenCalledWith("needs-review")
    expect(handleBeadClick).not.toHaveBeenCalled()
  })
})
