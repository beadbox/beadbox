// beadbox-984: reordering the Workspaces sidebar from the rail itself.
// Drag (native HTML5, as bead rows do), Alt+arrow keys on a focused row, the
// Move up/down menu items, and the live-region announcement (AC2). The rail is
// presentational: each path must call onMove(workspace, toIndex) with the
// right index; persistence is the hook's (use-workspace-rail-reorder.test.tsx).

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { WorkspaceRail, type WorkspaceRailProps } from "../components/workspace-rail"
import type { WorkspaceCard } from "../lib/types"

afterEach(cleanup)

const card = (id: string): WorkspaceCard => ({
  id: `id-${id}`,
  name: id,
  path: `/tmp/${id}`,
  databasePath: `/tmp/${id}/.beads`,
  mode: "embedded",
  available: true,
})
const list = ["alpha", "beta", "gamma", "delta"].map(card)

function renderRail(overrides: Partial<WorkspaceRailProps> = {}) {
  const onMove = mock((_w: WorkspaceCard, _to: number) => Promise.resolve(true))
  const props: WorkspaceRailProps = {
    workspaces: list,
    activeWorkspaceId: list[0].id,
    width: 260,
    collapsed: false,
    dashboardActive: false,
    switchingWorkspaceId: null,
    onDashboard: mock(() => {}),
    onSelect: mock(() => {}),
    onRemove: mock(() => {}),
    onRelabel: mock(() => Promise.resolve(true)),
    onMove,
    onAdd: mock(() => {}),
    onToggleCollapse: mock(() => {}),
    onResizePointerDown: mock(() => {}),
    ...overrides,
  }
  return { onMove, ...render(<WorkspaceRail {...props} />) }
}

const moves = (onMove: ReturnType<typeof mock>) =>
  onMove.mock.calls.map(([w, to]) => [(w as WorkspaceCard).name, to])

const open = (name: string) => screen.getByRole("button", { name: `Open ${name}` })
const item = (name: string) =>
  screen.getAllByTestId("workspace-rail-item").find((el) => el.dataset.workspaceId === `id-${name}`) as HTMLElement

/**
 * Fire dragover/drop at a vertical position. happy-dom's drag events carry
 * neither a DataTransfer nor clientY, so both are set on the event itself.
 */
function dragAt(kind: "dragOver" | "drop", el: HTMLElement, dt: ReturnType<typeof dataTransfer>, clientY: number) {
  const event = createEvent[kind](el, { dataTransfer: dt })
  Object.defineProperty(event, "clientY", { value: clientY })
  fireEvent(el, event)
}

/** A DataTransfer stand-in: happy-dom's drag events carry none. */
function dataTransfer() {
  const data = new Map<string, string>()
  return {
    data,
    effectAllowed: "",
    dropEffect: "",
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    get types() {
      return [...data.keys()]
    },
  }
}

describe("keyboard reorder", () => {
  test.each([
    ["Alt+ArrowDown", "beta", "{Alt>}{ArrowDown}{/Alt}", 2],
    ["Alt+ArrowUp", "gamma", "{Alt>}{ArrowUp}{/Alt}", 1],
    ["Alt+Home", "delta", "{Alt>}{Home}{/Alt}", 0],
    ["Alt+End", "alpha", "{Alt>}{End}{/Alt}", 3],
  ])("%s on a focused row moves it", async (_label, name, keys, to) => {
    const { onMove } = renderRail()
    open(name).focus()
    await userEvent.setup({ delay: null }).keyboard(keys)
    expect(moves(onMove)).toEqual([[name, to]])
  })

  test("nothing moves past either end, and arrows without Alt do nothing", async () => {
    const { onMove } = renderRail()
    const user = userEvent.setup({ delay: null })
    open("alpha").focus()
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}")
    await user.keyboard("{ArrowDown}")
    open("delta").focus()
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}")
    expect(onMove).not.toHaveBeenCalled()
  })

  test("the move is announced by name and position (AC2)", async () => {
    renderRail()
    open("delta").focus()
    await userEvent.setup({ delay: null }).keyboard("{Alt>}{Home}{/Alt}")
    const announcer = screen.getByTestId("workspace-rail-announcer")
    expect(announcer.getAttribute("aria-live")).toBe("polite")
    expect(announcer.textContent).toBe("delta moved to position 1 of 4")
  })

  test("each row's Open button tells assistive technology how to reorder", () => {
    renderRail()
    const hintId = open("beta").getAttribute("aria-describedby")
    expect(hintId).toBeTruthy()
    expect(document.getElementById(hintId as string)?.textContent).toBe("Alt+Up or Alt+Down to reorder")
  })
})

describe("menu reorder", () => {
  test("Move up and Move down move one place; each is disabled at its end", async () => {
    const { onMove } = renderRail()
    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Workspace options for gamma" }))
    await user.click(await screen.findByRole("menuitem", { name: "Move up" }))
    await user.click(screen.getByRole("button", { name: "Workspace options for alpha" }))
    expect((await screen.findByRole("menuitem", { name: "Move up" })).getAttribute("data-disabled")).not.toBeNull()
    await user.click(screen.getByRole("menuitem", { name: "Move down" }))
    expect(moves(onMove)).toEqual([
      ["gamma", 1],
      ["alpha", 1],
    ])
  })
})

describe("drag reorder", () => {
  // happy-dom lays nothing out (every rect is 0 high), so clientY < 0 is the
  // top half of a row and clientY > 0 the bottom half.
  test.each([
    ["delta onto alpha's top half", "delta", "alpha", -1, 0],
    ["alpha onto gamma's bottom half", "alpha", "gamma", 1, 2],
    ["alpha onto gamma's top half", "alpha", "gamma", -1, 1],
    ["beta onto delta's bottom half", "beta", "delta", 1, 3],
  ])("%s", (_label, from, onto, clientY, to) => {
    const { onMove } = renderRail()
    const dt = dataTransfer()
    fireEvent.dragStart(item(from), { dataTransfer: dt })
    expect(dt.getData("application/x-beadbox-workspace")).toBe(`id-${from}`)
    dragAt("dragOver", item(onto), dt, clientY)
    expect(screen.getByTestId("workspace-rail-drop-line")).toBeTruthy()
    dragAt("drop", item(onto), dt, clientY)
    expect(moves(onMove)).toEqual([[from, to]])
    expect(screen.getByTestId("workspace-rail-announcer").textContent).toBe(`${from} moved to position ${to + 1} of 4`)
  })

  test("a drop that lands where it started moves nothing", () => {
    const { onMove } = renderRail()
    const dt = dataTransfer()
    fireEvent.dragStart(item("beta"), { dataTransfer: dt })
    dragAt("dragOver", item("gamma"), dt, -1)
    dragAt("drop", item("gamma"), dt, -1)
    expect(onMove).not.toHaveBeenCalled()
  })

  test("something that is not a workspace (a bead, a file) is not taken", () => {
    const { onMove } = renderRail()
    const dt = dataTransfer()
    dt.setData("application/x-bead-move", "{}")
    dragAt("dragOver", item("alpha"), dt, -1)
    dragAt("drop", item("alpha"), dt, -1)
    expect(screen.queryByTestId("workspace-rail-drop-line")).toBeNull()
    expect(onMove).not.toHaveBeenCalled()
  })

  test("rows are draggable only when the rail can reorder", () => {
    renderRail()
    expect(item("alpha").getAttribute("draggable")).toBe("true")
    cleanup()
    renderRail({ onMove: undefined })
    expect(item("alpha").getAttribute("draggable")).toBe("false")
    expect(screen.queryByTestId("workspace-rail-announcer")).toBeNull()
  })
})
