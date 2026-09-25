import { afterEach, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { EpicTree } from "../components/epic-tree"
import {
  collectGroupedVisibleBeads,
  filterActiveEpicTree,
  partitionInactiveEpics,
} from "../components/home-page"
import type { Epic } from "../lib/types"

afterEach(cleanup)

function issue(id: string, title: string, type: Epic["type"]): Epic {
  return {
    id,
    title,
    type,
    description: "",
    status: "open",
    priority: "medium",
    assignee: "",
    comments: [],
    children: [],
    childEpics: [],
  }
}

test("groups only root milestones and epics while keeping nested epics under their milestone", () => {
  const nested = issue("nested-epic", "Nested epic", "epic")
  const milestone = issue("milestone", "Release milestone", "milestone")
  milestone.childEpics = [nested]
  const rootEpic = issue("root-epic", "Independent epic", "epic")

  render(
    <EpicTree
      epics={[rootEpic]}
      milestones={[milestone]}
      expandedEpics={new Set([milestone.id])}
      onToggleEpic={mock(() => {})}
      onBeadClick={mock(() => {})}
    />,
  )

  const milestoneHeading = screen.getByText("Milestones")
  const epicHeading = screen.getByText("Epics")
  expect(milestoneHeading.parentElement?.textContent).toContain("(1)")
  expect(epicHeading.parentElement?.textContent).toContain("(1)")
  expect(
    milestoneHeading.compareDocumentPosition(epicHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(screen.getAllByText("Release milestone")).toHaveLength(1)
  expect(screen.getAllByText("Nested epic")).toHaveLength(1)
  expect(screen.getAllByText("Independent epic")).toHaveLength(1)
})

test("milestone drag keeps its type and cannot become a loose bead or its own descendant", () => {
  const milestone = issue("milestone", "Release milestone", "milestone")
  const nested = issue("nested-epic", "Nested epic", "epic")
  nested.children = [{ ...nested, id: "task", title: "Nested task", type: "task" }]
  milestone.childEpics = [nested]
  const onBeadMove = mock(() => {})
  const canMoveEpic = mock(() => false)

  const { container } = render(
    <EpicTree
      epics={[]}
      milestones={[milestone]}
      expandedEpics={new Set([milestone.id, nested.id])}
      onToggleEpic={mock(() => {})}
      onBeadClick={mock(() => {})}
      onBeadMove={onBeadMove}
      canMoveEpic={canMoveEpic}
      draggedBeadId={milestone.id}
    />,
  )
  const milestoneRow = container.querySelector('[data-item-id="milestone"] [draggable="true"]')!
  const nestedRow = container.querySelector('[data-item-id="nested-epic"] [draggable="true"]')!
  const setData = mock((_key: string, _value: string) => {})
  fireEvent.dragStart(milestoneRow, { dataTransfer: { setData, effectAllowed: "" } })
  expect(JSON.parse(setData.mock.calls[0]![1]).type).toBe("milestone")
  expect(screen.getByText("Milestones cannot be loose")).toBeTruthy()

  const dataTransfer = {
    getData: () => JSON.stringify({ beadId: milestone.id, sourceEpicId: null, type: "milestone" }),
    dropEffect: "move",
  }
  fireEvent.drop(screen.getByText("Milestones cannot be loose"), { dataTransfer })
  expect(onBeadMove).not.toHaveBeenCalled()
  fireEvent.drop(nestedRow, { dataTransfer })
  expect(canMoveEpic).toHaveBeenCalledWith(milestone.id, nested.id)
  expect(onBeadMove).not.toHaveBeenCalled()

  const nestedContent = nestedRow.parentElement!.querySelector(":scope > .border-t")!
  fireEvent.drop(nestedContent, { dataTransfer })
  expect(onBeadMove).not.toHaveBeenCalled()

  fireEvent.drop(nestedContent, {
    dataTransfer: {
      getData: () => JSON.stringify({ beadId: "task", sourceEpicId: milestone.id, type: "task" }),
    },
  })
  expect(onBeadMove).toHaveBeenCalledTimes(1)
  expect(onBeadMove).toHaveBeenCalledWith("task", nested.id)
})

test("nested backlogged and archived epics stay under their milestone", () => {
  const milestone = issue("milestone", "Release milestone", "milestone")
  const backlog = issue("backlog-epic", "Backlog epic", "epic")
  backlog.priority = "backlog"
  const archived = issue("archived-epic", "Archived epic", "epic")
  archived.labels = ["archived"]
  const active = issue("active-epic", "Active epic", "epic")
  milestone.childEpics = [backlog, archived, active]

  const sections = partitionInactiveEpics([milestone])
  expect(sections.backlogEpics).toEqual([])
  expect(sections.archivedEpics).toEqual([])
  expect(filterActiveEpicTree(milestone).childEpics?.map((epic) => epic.id)).toEqual([
    backlog.id,
    archived.id,
    active.id,
  ])

  const grouped = collectGroupedVisibleBeads(
    [filterActiveEpicTree(milestone)],
    [...sections.backlogEpics, ...sections.archivedEpics],
    [backlog],
    [archived],
  )
  expect(grouped.map((bead) => bead.id)).toEqual([milestone.id, backlog.id, archived.id, active.id])

  const onlyEpics = collectGroupedVisibleBeads(
    [filterActiveEpicTree(milestone)],
    [],
    [],
    [],
    (bead) => bead.type === "epic",
  )
  expect(onlyEpics.map((bead) => bead.id)).toEqual([backlog.id, archived.id, active.id])
})

test("nested inactive epics can be restored in place", () => {
  const milestone = issue("milestone", "Release milestone", "milestone")
  const backlog = issue("backlog-epic", "Backlog epic", "epic")
  backlog.priority = "backlog"
  const archived = issue("archived-epic", "Archived epic", "epic")
  archived.labels = ["archived"]
  milestone.childEpics = [backlog, archived]
  const onBacklog = mock(() => {})
  const onArchive = mock(() => {})

  render(
    <EpicTree
      epics={[]}
      milestones={[milestone]}
      expandedEpics={new Set([milestone.id])}
      onToggleEpic={mock(() => {})}
      onBeadClick={mock(() => {})}
      onBacklog={onBacklog}
      onArchive={onArchive}
    />,
  )

  fireEvent.click(screen.getByLabelText("Restore epic from backlog: Backlog epic"))
  fireEvent.click(screen.getByLabelText("Unarchive epic: Archived epic"))
  expect(onBacklog).toHaveBeenCalledWith(backlog.id, false)
  expect(onArchive).toHaveBeenCalledWith(archived.id, false)
  expect(screen.queryByText("Backlog")).toBeNull()
  expect(screen.queryByText("Archived")).toBeNull()
})
