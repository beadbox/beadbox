// beadbox-44u: the Backlog section lists each P4 bead exactly once. A P4 bead
// under a P4 (Backlog) epic appears only inside that epic's row; a P4 bead
// under an active epic, or with no parent, appears only in the loose table.
// An epic row's n/m describes exactly what its expansion contains.

import { afterEach, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { EpicTree } from "../components/epic-tree"
import {
  collectBacklogBeads,
  filterActiveEpicTree,
  partitionInactiveEpics,
} from "../components/home-page"
import type { Bead, Epic } from "../lib/types"

afterEach(cleanup)

function epic(id: string, type: Epic["type"], priority: Epic["priority"]): Epic {
  return {
    id,
    title: `title ${id}`,
    type,
    description: "",
    status: "open",
    priority,
    assignee: "",
    comments: [],
    children: [],
    childEpics: [],
  }
}

function bead(id: string, priority: Bead["priority"]): Bead {
  return { ...epic(id, "task", priority), childEpics: undefined } as Bead
}

// The fixture, as bd would report it:
//   E4 (P4 epic)       -> t1 (P4); N4 (P4 epic, nested) -> t4 (P4)
//   E1 (P1 epic)       -> t5 (P2), t2 (P4)
//   M  (P1 milestone)  -> N5 (P4 epic, nested under an ACTIVE milestone) -> t7 (P4)
//   _standalone        -> t3 (P4), t6 (P2)
function fixture() {
  const e4 = epic("E4", "epic", "backlog")
  const n4 = epic("N4", "epic", "backlog")
  n4.children = [bead("t4", "backlog")]
  e4.children = [bead("t1", "backlog")]
  e4.childEpics = [n4]

  const e1 = epic("E1", "epic", "high")
  e1.children = [bead("t5", "medium"), bead("t2", "backlog")]

  const m = epic("M", "milestone", "high")
  const n5 = epic("N5", "epic", "backlog")
  n5.children = [bead("t7", "backlog")]
  m.childEpics = [n5]

  const standalone = epic("_standalone", "epic", "medium")
  standalone.children = [bead("t3", "backlog"), bead("t6", "medium")]

  const sorted = [e1, e4, standalone]
  const milestones = [m]
  return { sorted, milestones, all: [...sorted, ...milestones] }
}

function looseIds(): string[] {
  const { all } = fixture()
  const { backlogEpics } = partitionInactiveEpics(all)
  return collectBacklogBeads(all, backlogEpics).map((b) => b.id)
}

test("AC1: a P4 bead under a P4 epic is not in the loose table, at any depth inside that epic", () => {
  const loose = looseIds()
  expect(loose).not.toContain("t1")
  expect(loose).not.toContain("t4")
})

test("AC2: a P4 bead under an active epic is in the loose table", () => {
  expect(looseIds()).toContain("t2")
})

test("AC2: a P4 bead under a P4 epic NESTED in an active milestone stays in the loose table", () => {
  // That nested epic is rendered in the active tree (beadbox-51m) with its P4
  // children filtered out, so the loose table is the only place they appear.
  expect(looseIds()).toContain("t7")
})

test("AC3: a P4 bead with no parent is in the loose table; non-P4 beads never are", () => {
  const loose = looseIds()
  expect(loose).toContain("t3")
  expect(loose).not.toContain("t5")
  expect(loose).not.toContain("t6")
})

test("rendered: every P4 bead appears exactly once, under the right parent, and n/m matches the expansion", () => {
  const { sorted, milestones, all } = fixture()
  const { backlogEpics } = partitionInactiveEpics(all)
  const backlogBeads = collectBacklogBeads(all, backlogEpics)
  const active = sorted.filter((e) => e.priority !== "backlog" && e.id !== "_standalone").map(filterActiveEpicTree)
  const expanded = new Set(["E4", "N4", "E1", "M", "N5"])

  const { container } = render(
    <EpicTree
      epics={active}
      milestones={milestones.map(filterActiveEpicTree)}
      backlogEpics={backlogEpics}
      backlogBeads={backlogBeads}
      expandedEpics={expanded}
      onToggleEpic={mock(() => {})}
      onBeadClick={mock(() => {})}
    />,
  )
  // The Backlog section starts collapsed; open it the way a user does.
  const header = screen.getByText("Backlog").closest("button")
  expect(header).not.toBeNull()
  fireEvent.click(header as HTMLButtonElement)
  const rows = (id: string) => container.querySelectorAll(`[data-item-id="${id}"]`).length
  const within = (epicId: string, id: string) =>
    container.querySelector(`[data-item-id="${epicId}"]`)?.querySelector(`[data-item-id="${id}"]`) != null

  // Each P4 bead exactly once (AC1-AC3).
  for (const id of ["t1", "t4", "t2", "t3", "t7"]) expect({ id, rows: rows(id) }).toEqual({ id, rows: 1 })
  // AC1: the backlog epic's subtree is rendered under its row.
  expect(within("E4", "t1")).toBe(true)
  expect(within("E4", "t4")).toBe(true)
  // AC2: the active epic shows its non-P4 child and not its P4 one.
  expect(within("E1", "t5")).toBe(true)
  expect(within("E1", "t2")).toBe(false)
  // AC4 (revised): n/m counts exactly what the expansion contains.
  // E4: t1 + t4 (via N4) = 0/2. E1 (active): t5 only = 0/1; t2 is not counted.
  expect(container.querySelector('[data-item-id="E4"]')?.textContent).toContain("0/2")
  expect(container.querySelector('[data-item-id="E1"]')?.textContent).toContain("0/1")
})
