// WorkspaceRail — RTL render contract for the left workspace tab rail.
//
// Presentational surface only (state/rpc live in hooks/use-workspace-rail.ts):
// tab list, active highlight, dashboard / add / remove wiring, collapsed
// mode, and the persisted width reaching the DOM.
// userEvent.setup({ delay: null }) per bb-w4ee.

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  WORKSPACE_RAIL_COLLAPSED_WIDTH,
  WorkspaceRail,
  type WorkspaceRailProps,
} from "../components/workspace-rail"
import type { WorkspaceCard } from "../lib/types"

type RailLabel = { name?: string; icon?: string | null }

const relabelMock = () => mock((_ws: WorkspaceCard, _label: RailLabel) => Promise.resolve(true))

afterEach(cleanup)

const userInstance = () => userEvent.setup({ delay: null })

const local: WorkspaceCard = {
  id: "ws-local",
  name: "beadbox",
  path: "/Users/dev/beadbox",
  databasePath: "/Users/dev/beadbox/.beads",
  mode: "embedded",
  available: true,
}

const remote: WorkspaceCard = {
  id: "ws-remote",
  name: "gastown",
  path: null,
  databasePath: "server://dolt.internal:3306/gastown",
  mode: "server",
  serverHost: "dolt.internal",
  serverPort: 3306,
  serverDatabase: "gastown",
  available: true,
}

function renderRail(overrides: Partial<WorkspaceRailProps> = {}) {
  const props: WorkspaceRailProps = {
    workspaces: [local, remote],
    activeWorkspaceId: local.id,
    width: 260,
    collapsed: false,
    dashboardActive: false,
    switchingWorkspaceId: null,
    onDashboard: mock(() => {}),
    onSelect: mock(() => {}),
    onRemove: mock(() => {}),
    onRelabel: relabelMock(),
    onAdd: mock(() => {}),
    onToggleCollapse: mock(() => {}),
    onResizePointerDown: mock(() => {}),
    ...overrides,
  }
  return { props, ...render(<WorkspaceRail {...props} />) }
}

describe("WorkspaceRail", () => {
  test("renders one tab per workspace", () => {
    renderRail()
    expect(screen.getAllByTestId("workspace-rail-item")).toHaveLength(2)
    expect(screen.getByText("beadbox")).toBeTruthy()
    expect(screen.getByText("gastown")).toBeTruthy()
  })

  test("marks only the active workspace with aria-current", () => {
    renderRail()
    expect(screen.getByRole("button", { name: "Open beadbox" }).getAttribute("aria-current")).toBe(
      "page",
    )
    expect(
      screen.getByRole("button", { name: "Open gastown" }).getAttribute("aria-current"),
    ).toBeNull()
  })

  test("no workspace tab is current while the dashboard is active", () => {
    renderRail({ dashboardActive: true })
    expect(screen.getByRole("button", { name: "Open beadbox" }).getAttribute("aria-current")).toBe(
      null,
    )
    expect(screen.getByTestId("workspace-rail-dashboard").getAttribute("aria-current")).toBe("page")
  })

  test("clicking a tab selects that workspace", async () => {
    const onSelect = mock((_ws: WorkspaceCard) => {})
    const user = userInstance()
    renderRail({ onSelect })
    await user.click(screen.getByRole("button", { name: "Open gastown" }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0]?.[0]).toBe(remote)
  })

  test("dashboard button navigates back to the workspace overview", async () => {
    const onDashboard = mock(() => {})
    const user = userInstance()
    renderRail({ onDashboard })
    await user.click(screen.getByTestId("workspace-rail-dashboard"))
    expect(onDashboard).toHaveBeenCalledTimes(1)
  })

  test("add button opens the add-workspace flow", async () => {
    const onAdd = mock(() => {})
    const user = userInstance()
    renderRail({ onAdd })
    await user.click(screen.getByTestId("workspace-rail-add"))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  test("tab menu reports the workspace to remove", async () => {
    const onRemove = mock((_ws: WorkspaceCard) => {})
    const onSelect = mock((_ws: WorkspaceCard) => {})
    const user = userInstance()
    renderRail({ onRemove, onSelect })
    await user.click(screen.getByRole("button", { name: "Workspace options for gastown" }))
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }))
    expect(onRemove.mock.calls[0]?.[0]).toBe(remote)
    // Removal must not double as a switch.
    expect(onSelect).not.toHaveBeenCalled()
  })

  test("double-clicking a tab renames it, and Escape abandons the edit", async () => {
    const onRelabel = relabelMock()
    const user = userInstance()
    renderRail({ onRelabel })

    await user.dblClick(screen.getByRole("button", { name: "Open gastown" }))
    const input = screen.getByRole("textbox", { name: "Rename gastown" })
    await user.clear(input)
    await user.type(input, "Gastown prod{Enter}")
    expect(onRelabel.mock.calls[0]?.[0]).toBe(remote)
    expect(onRelabel.mock.calls[0]?.[1]).toEqual({ name: "Gastown prod" })

    await user.dblClick(screen.getByRole("button", { name: "Open beadbox" }))
    const second = screen.getByRole("textbox", { name: "Rename beadbox" })
    await user.type(second, " edited{Escape}")
    expect(onRelabel).toHaveBeenCalledTimes(1)
    expect(screen.getByText("beadbox")).toBeTruthy()
  })

  test("an empty or unchanged rename is not submitted", async () => {
    const onRelabel = relabelMock()
    const user = userInstance()
    renderRail({ onRelabel })

    await user.dblClick(screen.getByRole("button", { name: "Open beadbox" }))
    const input = screen.getByRole("textbox", { name: "Rename beadbox" })
    await user.clear(input)
    await user.type(input, "   {Enter}")
    expect(onRelabel).not.toHaveBeenCalled()

    await user.dblClick(screen.getByRole("button", { name: "Open beadbox" }))
    await user.type(screen.getByRole("textbox", { name: "Rename beadbox" }), "{Enter}")
    expect(onRelabel).not.toHaveBeenCalled()
  })

  test("tab avatar opens the edit dialog, which reports the chosen emoji", async () => {
    const onRelabel = relabelMock()
    const user = userInstance()
    renderRail({ onRelabel })

    await user.click(screen.getByRole("button", { name: "Edit beadbox tab" }))
    await user.click(await screen.findByRole("button", { name: "Use 🚀" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    // One call carrying only the changed field: name + icon must never go out
    // as two overlapping registry writes.
    expect(onRelabel).toHaveBeenCalledTimes(1)
    expect(onRelabel.mock.calls[0]?.[0]).toBe(local)
    expect(onRelabel.mock.calls[0]?.[1]).toEqual({ icon: "🚀" })
  })

  test("the tab menu opens the same edit dialog and renames from it", async () => {
    const onRelabel = relabelMock()
    const user = userInstance()
    renderRail({ onRelabel })

    await user.click(screen.getByRole("button", { name: "Workspace options for gastown" }))
    await user.click(await screen.findByRole("menuitem", { name: "Edit name & icon" }))
    const nameInput = await screen.findByRole("textbox", { name: "Workspace name" })
    await user.clear(nameInput)
    await user.type(nameInput, "Gastown prod")
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onRelabel.mock.calls[0]?.[0]).toBe(remote)
    expect(onRelabel.mock.calls[0]?.[1]).toEqual({ name: "Gastown prod" })
  })

  test("the edit dialog's Clear button removes an existing emoji", async () => {
    const onRelabel = relabelMock()
    const user = userInstance()
    const iconed = { ...local, icon: "🚀" }
    renderRail({ workspaces: [iconed], activeWorkspaceId: iconed.id, onRelabel })

    await user.click(screen.getByRole("button", { name: "Edit beadbox tab" }))
    await user.click(screen.getByRole("button", { name: "Clear" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onRelabel.mock.calls[0]?.[1]).toEqual({ icon: null })
  })

  test("editing name and icon together submits a single relabel", async () => {
    const onRelabel = relabelMock()
    const user = userInstance()
    renderRail({ onRelabel })

    await user.click(screen.getByRole("button", { name: "Edit beadbox tab" }))
    const nameInput = await screen.findByRole("textbox", { name: "Workspace name" })
    await user.clear(nameInput)
    await user.type(nameInput, "Beadbox core")
    await user.click(screen.getByRole("button", { name: "Use 🧪" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(onRelabel).toHaveBeenCalledTimes(1)
    expect(onRelabel.mock.calls[0]?.[1]).toEqual({ name: "Beadbox core", icon: "🧪" })
  })

  test("renders the workspace emoji in place of the default glyph", () => {
    renderRail({ workspaces: [{ ...local, icon: "🚀" }], activeWorkspaceId: local.id })
    expect(screen.getByText("🚀")).toBeTruthy()
  })

  test("applies the persisted width when expanded", () => {
    renderRail({ width: 312 })
    expect(screen.getByTestId("workspace-rail").style.width).toBe("312px")
  })

  test("collapsed rail is icon-only: no labels, no menu, no resize handle", () => {
    renderRail({ collapsed: true, width: 312 })
    expect(screen.getByTestId("workspace-rail").style.width).toBe(
      `${WORKSPACE_RAIL_COLLAPSED_WIDTH}px`,
    )
    expect(screen.queryByText("beadbox")).toBeNull()
    expect(screen.queryByRole("button", { name: "Workspace options for beadbox" })).toBeNull()
    expect(screen.queryByTestId("workspace-rail-resize-handle")).toBeNull()
    // Tabs stay reachable by their accessible name.
    expect(screen.getByRole("button", { name: "Open beadbox" })).toBeTruthy()
  })

  test("collapse toggle flips its accessible name and fires the callback", async () => {
    const onToggleCollapse = mock(() => {})
    const user = userInstance()
    const { unmount } = renderRail({ onToggleCollapse })
    await user.click(screen.getByRole("button", { name: "Collapse workspace sidebar" }))
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
    unmount()

    renderRail({ collapsed: true })
    expect(screen.getByRole("button", { name: "Expand workspace sidebar" })).toBeTruthy()
  })

  test("resize handle forwards pointerdown to the drag controller", async () => {
    const onResizePointerDown = mock(() => {})
    const user = userInstance()
    renderRail({ onResizePointerDown })
    await user.pointer({
      target: screen.getByTestId("workspace-rail-resize-handle"),
      keys: "[MouseLeft>]",
    })
    expect(onResizePointerDown).toHaveBeenCalledTimes(1)
  })

  test("shows a spinner on the workspace being switched to", () => {
    const { container } = renderRail({ switchingWorkspaceId: remote.id })
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1)
  })

  test("empty registry shows the empty hint", () => {
    renderRail({ workspaces: [], activeWorkspaceId: null })
    expect(screen.queryAllByTestId("workspace-rail-item")).toHaveLength(0)
    expect(screen.getByText("No workspaces yet")).toBeTruthy()
  })
})
