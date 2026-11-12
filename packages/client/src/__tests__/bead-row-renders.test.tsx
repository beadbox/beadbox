import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { cleanup, fireEvent, render, within } from "@testing-library/react"
import { BeadTable } from "../components/bead-table"
import * as dueFormat from "../lib/due-format"
import type { Bead } from "../lib/types"

afterEach(cleanup)
const bead = (id: string, day: number): Bead => ({
  id,
  title: `Task ${id}`,
  type: "task",
  description: "",
  status: "open",
  priority: "medium",
  assignee: "",
  comments: [],
  dueAt: new Date(2030, 0, day),
})

test("a fresh tree reply changing one bead renders only that row and uses latest callbacks", () => {
  // describeDueAt runs once in each row render, including memoized nested rows.
  const due = spyOn(dueFormat, "describeDueAt")
  try {
    const original = [bead("first", 1), bead("second", 2)]
    const clicked = mock(() => {})
    const view = render(<BeadTable beads={original} epicId="epic" onBeadClick={() => {}} />)
    due.mockClear()
    const fresh = original.map((b) => ({ ...b, dueAt: new Date(b.dueAt!), comments: [] }))
    fresh[0].title = "changed"
    view.rerender(<BeadTable beads={fresh} epicId="epic" onBeadClick={clicked} />)
    expect(due.mock.calls.map(([date]) => new Date(date).getDate())).toEqual([1])
    fireEvent.click(view.getByText("Task second"))
    expect(clicked).toHaveBeenCalledWith(fresh[1])
  } finally {
    due.mockRestore()
  }
})

test("memoized nested rows update expansion, selection and keyboard focus", () => {
  const child = bead("child", 3)
  const parent = { ...bead("parent", 1), children: [child] }
  const sibling = bead("sibling", 2)
  const toggle = mock(() => {})
  const props = {
    beads: [parent, sibling],
    epicId: "epic",
    onBeadClick: () => {},
    onToggleBead: toggle,
    onToggleSelect: () => {},
    expandedBeads: new Set<string>(),
    selectedIds: new Set<string>(),
  }
  const view = render(<BeadTable {...props} />)
  expect(view.queryByText("Task child")).toBeNull()
  view.rerender(
    <BeadTable
      {...props}
      expandedBeads={new Set(["parent"])}
      selectedIds={new Set(["child"])}
      focusedItemId="child"
    />,
  )
  const row = view.container.querySelector('[data-item-id="child"]')!
  expect(
    within(row as HTMLElement)
      .getByRole("checkbox")
      .getAttribute("aria-checked"),
  ).toBe("true")
  expect(row.className).toContain("ring-1")
  view.rerender(
    <BeadTable
      {...props}
      expandedBeads={new Set(["parent"])}
      selectedBeadId="sibling"
      focusedItemId="sibling"
    />,
  )
  expect(view.container.querySelector('[data-item-id="child"]')!.className).not.toContain("ring-1")
  expect(view.container.querySelector('[data-item-id="sibling"]')!.className).toContain(
    "bg-primary/15",
  )
})

test("changing a nested bead does not render its unchanged parent or sibling rows", () => {
  const due = spyOn(dueFormat, "describeDueAt")
  try {
    const parent = { ...bead("parent", 1), children: [bead("child", 3), bead("other-child", 4)] }
    const props = { epicId: "epic", onBeadClick: () => {}, expandedBeads: new Set(["parent"]) }
    const view = render(<BeadTable {...props} beads={[parent, bead("sibling", 2)]} />)
    due.mockClear()
    const next = { ...parent, children: parent.children.map((b) => ({ ...b })) }
    next.children[0].title = "Edited child"
    view.rerender(<BeadTable {...props} beads={[next, bead("sibling", 2)]} />)
    expect(due.mock.calls.map(([date]) => new Date(date).getDate())).toEqual([3])
  } finally {
    due.mockRestore()
  }
})

test("aggregate source lookup replacement does not render unchanged project rows", () => {
  const due = spyOn(dueFormat, "describeDueAt")
  try {
    const rows = [bead("first", 1), bead("second", 2)]
    const view = render(
      <BeadTable
        beads={rows}
        epicId="all"
        flat
        onBeadClick={() => {}}
        sourceForBead={() => ({ id: "project", name: "Project" })}
      />,
    )
    due.mockClear()
    const next = rows.map((b) => ({ ...b }))
    next[0].title = "Updated project bead"
    view.rerender(
      <BeadTable
        beads={next}
        epicId="all"
        flat
        onBeadClick={() => {}}
        sourceForBead={() => ({ id: "project", name: "Project" })}
      />,
    )
    expect(due.mock.calls.map(([date]) => new Date(date).getDate())).toEqual([1])
  } finally {
    due.mockRestore()
  }
})
