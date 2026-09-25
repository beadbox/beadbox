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

// beadbox-51m (inverts #48's original test): an ARCHIVED epic nested under a
// milestone leaves the main tree for the Archived section, like any other
// archived epic. BACKLOGGED nested epics keep #48's placement under their
// milestone (deferred work still belongs to the milestone's plan).
test("a nested archived epic goes to Archived; a nested backlogged epic stays under its milestone", () => {
  const milestone = issue("milestone", "Release milestone", "milestone")
  const backlog = issue("backlog-epic", "Backlog epic", "epic")
  backlog.priority = "backlog"
  const archived = issue("archived-epic", "Archived epic", "epic")
  archived.labels = ["archived"]
  const active = issue("active-epic", "Active epic", "epic")
  milestone.childEpics = [backlog, archived, active]

  const sections = partitionInactiveEpics([milestone])
  expect(sections.backlogEpics).toEqual([])
  expect(sections.archivedEpics.map((epic) => epic.id)).toEqual([archived.id])
  expect(filterActiveEpicTree(milestone).childEpics?.map((epic) => epic.id)).toEqual([
    backlog.id,
    active.id,
  ])

  const grouped = collectGroupedVisibleBeads(
    [filterActiveEpicTree(milestone)],
    [...sections.backlogEpics, ...sections.archivedEpics],
    [backlog],
    [archived],
  )
  expect(grouped.map((bead) => bead.id)).toEqual([milestone.id, backlog.id, active.id, archived.id])
})

test("archived epics nested deeper, under an archived root, and at the top level are each listed once", () => {
  const milestone = issue("milestone", "Release milestone", "milestone")
  const epic = issue("epic", "Live epic", "epic")
  const deep = issue("deep", "Deep archived epic", "epic")
  deep.labels = ["archived"]
  epic.childEpics = [deep]
  milestone.childEpics = [epic]

  const archivedMilestone = issue("old-milestone", "Old milestone", "milestone")
  archivedMilestone.labels = ["archived"]
  const insideArchived = issue("inside", "Archived inside archived", "epic")
  insideArchived.labels = ["archived"]
  archivedMilestone.childEpics = [insideArchived]

  const topArchived = issue("top", "Top-level archived epic", "epic")
  topArchived.labels = ["archived"]

  const sections = partitionInactiveEpics([milestone, archivedMilestone, topArchived])
  expect(sections.archivedEpics.map((e) => e.id).sort()).toEqual(
    [deep.id, archivedMilestone.id, topArchived.id].sort(),
  )
  expect(filterActiveEpicTree(milestone).childEpics?.[0].childEpics).toEqual([])
})

test("unarchiving puts the epic back under its milestone", () => {
  const milestone = issue("milestone", "Release milestone", "milestone")
  const epic = issue("was-archived", "Was archived", "epic")
  epic.labels = ["archived"]
  milestone.childEpics = [epic]
  expect(partitionInactiveEpics([milestone]).archivedEpics.map((e) => e.id)).toEqual([epic.id])

  // What the next tree load returns after `bd label remove <id> archived`.
  epic.labels = []
  expect(partitionInactiveEpics([milestone]).archivedEpics).toEqual([])
  expect(filterActiveEpicTree(milestone).childEpics?.map((e) => e.id)).toEqual([epic.id])
})

test("a milestone whose only child epic is archived still shows, with nothing archived under it", () => {
  const milestone = issue("milestone", "Release milestone", "milestone")
  const archived = issue("archived-epic", "Archived epic", "epic")
  archived.labels = ["archived"]
  milestone.childEpics = [archived]
  const onArchive = mock(() => {})

  render(
    <EpicTree
      epics={[]}
      milestones={[filterActiveEpicTree(milestone)]}
      archivedEpics={partitionInactiveEpics([milestone]).archivedEpics}
      expandedEpics={new Set([milestone.id])}
      onToggleEpic={mock(() => {})}
      onBeadClick={mock(() => {})}
      onArchive={onArchive}
    />,
  )
  expect(screen.getByText("Release milestone")).toBeTruthy()
  // The archived epic is not rendered under the milestone; it's in Archived.
  expect(screen.queryByText("Archived epic")).toBeNull()
  expect(screen.getByText("Archived")).toBeTruthy()
})

test("a nested backlogged epic restores in place; an archived one unarchives from the Archived section", () => {
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
      milestones={[filterActiveEpicTree(milestone)]}
      archivedEpics={partitionInactiveEpics([milestone]).archivedEpics}
      expandedEpics={new Set([milestone.id])}
      onToggleEpic={mock(() => {})}
      onBeadClick={mock(() => {})}
      onBacklog={onBacklog}
      onArchive={onArchive}
    />,
  )

  fireEvent.click(screen.getByLabelText("Restore epic from backlog: Backlog epic"))
  expect(onBacklog).toHaveBeenCalledWith(backlog.id, false)
  // The Archived section starts collapsed; open it, then unarchive from there.
  fireEvent.click(screen.getByText("Archived"))
  fireEvent.click(screen.getByLabelText("Unarchive epic: Archived epic"))
  expect(onArchive).toHaveBeenCalledWith(archived.id, false)
})
