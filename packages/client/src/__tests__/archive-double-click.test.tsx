// beadbox-d6l regression (QAM): a real double-click on "Archive" archived TWO
// beads. The first click removes the row at once, the next row slides under the
// pointer, and the second click of the double-click landed on its button.
// Two clicks at the same point within a double-click interval must archive
// exactly one bead, for bead rows and epic rows alike.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { BeadTable } from "../components/bead-table"
import { EpicTree } from "../components/epic-tree"
import { TooltipProvider } from "../components/ui/tooltip"
import { _resetArchiveClickGuard } from "../lib/archive-click-guard"
import type { Bead, Epic } from "../lib/types"

let now = 1_000_000
beforeEach(() => {
  _resetArchiveClickGuard()
  now = 1_000_000
  spyOn(Date, "now").mockImplementation(() => now)
})
afterEach(() => {
  cleanup()
  ;(Date.now as unknown as { mockRestore?: () => void }).mockRestore?.()
})

const bead = (id: string): Bead =>
  ({ id, title: `Title ${id}`, type: "task", status: "open", priority: "medium", assignee: "", comments: [] }) as unknown as Bead
const epic = (id: string): Epic =>
  ({ id, title: `Epic ${id}`, type: "epic", status: "open", priority: "medium", children: [], childEpics: [], labels: [] }) as unknown as Epic

function rows(beads: Bead[], onArchive: (id: string) => Promise<void>) {
  return (
    <TooltipProvider>
      <BeadTable beads={beads} epicId="e" onBeadClick={() => {}} onArchive={onArchive} />
    </TooltipProvider>
  )
}
const beadButton = (id: string) => screen.getByRole("button", { name: `Archive bead ${id}` })

describe("bead rows", () => {
  test("a double-click archives one bead even when the next row slides under the pointer", () => {
    const onArchive = mock(async (_id: string) => {})
    const view = render(rows([bead("a"), bead("b")], onArchive))
    fireEvent.click(beadButton("a"), { detail: 1 })
    // Row a leaves at once; b takes its place under the pointer.
    view.rerender(rows([bead("b")], onArchive))
    now += 120
    fireEvent.click(beadButton("b"), { detail: 2 })
    expect(onArchive.mock.calls.map((c) => c[0])).toEqual(["a"])
  })

  test("a follow-up click inside the guard window is ignored even if the engine reset its click count", () => {
    const onArchive = mock(async (_id: string) => {})
    const view = render(rows([bead("a"), bead("b")], onArchive))
    fireEvent.click(beadButton("a"), { detail: 1 })
    view.rerender(rows([bead("b")], onArchive))
    now += 200
    fireEvent.click(beadButton("b"), { detail: 1 })
    expect(onArchive.mock.calls.map((c) => c[0])).toEqual(["a"])
  })

  test("a deliberate archive of the next bead after the window still works", () => {
    const onArchive = mock(async (_id: string) => {})
    const view = render(rows([bead("a"), bead("b")], onArchive))
    fireEvent.click(beadButton("a"), { detail: 1 })
    view.rerender(rows([bead("b")], onArchive))
    now += 700
    fireEvent.click(beadButton("b"), { detail: 1 })
    expect(onArchive.mock.calls.map((c) => c[0])).toEqual(["a", "b"])
  })
})

describe("epic rows", () => {
  function tree(epics: Epic[], onArchive: (id: string, archived: boolean) => void) {
    return (
      <TooltipProvider>
        <EpicTree
          epics={epics}
          expandedEpics={new Set()}
          onToggleEpic={() => {}}
          onBeadClick={() => {}}
          onArchive={onArchive}
        />
      </TooltipProvider>
    )
  }
  const epicButton = (title: string) => screen.getByRole("button", { name: `Archive epic: ${title}` })

  test("a double-click archives one epic when the next epic slides under the pointer", () => {
    const onArchive = mock((_id: string, _a: boolean) => {})
    const view = render(tree([epic("e1"), epic("e2")], onArchive))
    fireEvent.click(epicButton("Epic e1"), { detail: 1 })
    view.rerender(tree([epic("e2")], onArchive))
    now += 120
    fireEvent.click(epicButton("Epic e2"), { detail: 2 })
    expect(onArchive.mock.calls.map((c) => c[0])).toEqual(["e1"])
  })
})
