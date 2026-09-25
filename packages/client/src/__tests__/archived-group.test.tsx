// beadbox-51m (widened by Nelson): EVERY archived item, epics and loose beads,
// wherever it sits, goes into the Archived group, and hiding that group sticks.
// Probed on main first: archived items leaked into the Backlog section and the
// grouped view's status groups, and the group's collapsed state reset on every
// remount. Synthetic items only.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { EpicTree } from "../components/epic-tree"
import * as home from "../components/home-page"
import { filterActiveEpicTree, partitionInactiveEpics } from "../components/home-page"
import type { Bead, Epic } from "../lib/types"

function epic(id: string, title: string, type: Epic["type"] = "epic"): Epic {
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

function bead(id: string, title: string, labels: string[] = []): Bead {
  return {
    id,
    title,
    type: "task",
    description: "",
    status: "open",
    priority: "medium",
    assignee: "",
    comments: [],
    labels,
  } as unknown as Bead
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("archived items never show outside the Archived group", () => {
  test("an archived bead inside a backlogged epic is not in the Backlog section", () => {
    const backlogged = epic("blog", "Backlogged epic")
    backlogged.priority = "backlog" as Epic["priority"]
    const live = bead("lb", "Live backlog task")
    const archived = bead("ab", "Archived in backlog", ["archived"])
    backlogged.children = [live, archived]
    const { backlogEpics } = partitionInactiveEpics([backlogged])

    render(
      <EpicTree
        epics={[]}
        backlogEpics={backlogEpics}
        archivedBeads={[archived]}
        expandedEpics={new Set(["blog"])}
        onToggleEpic={mock(() => {})}
        onBeadClick={mock(() => {})}
      />,
    )
    fireEvent.click(screen.getByText("Backlog"))
    expect(screen.getByText("Live backlog task")).toBeTruthy()
    // Archived stays collapsed, so an archived item may not be on screen at all.
    expect(screen.queryByText("Archived in backlog")).toBeNull()
  })

  test("grouped view: an archived loose bead is in the Archived group, not a status group", () => {
    type Split = (
      active: Epic[],
      backlogEpics: Epic[],
      archivedEpics: Epic[],
      backlogBeads: Bead[],
      archivedBeads: Bead[],
    ) => { live: Bead[]; archived: Bead[] }
    const split = (home as unknown as { splitGroupedBeads?: Split }).splitGroupedBeads
    const standalone = epic("_standalone", "Standalone")
    const loose = bead("live", "Live loose")
    const gone = bead("gone", "Archived loose", ["archived"])
    standalone.children = [loose, gone]
    const milestone = epic("m", "Milestone", "milestone")
    const archivedEpic = epic("ae", "Archived epic")
    archivedEpic.labels = ["archived"]
    archivedEpic.children = [bead("ae-task", "Task in archived epic")]
    milestone.childEpics = [archivedEpic]
    const roots = [standalone, milestone]
    const { backlogEpics, archivedEpics } = partitionInactiveEpics(roots)

    const result = split?.(roots.map(filterActiveEpicTree), backlogEpics, archivedEpics, [], [gone])
    expect(result?.live.map((b) => b.id)).not.toContain("gone")
    expect(result?.live.map((b) => b.id)).not.toContain("ae-task")
    expect(result?.archived.map((b) => b.id).sort()).toEqual(["ae", "ae-task", "gone"].sort())
  })
})

describe("the Archived group's collapsed state persists", () => {
  const props = () => ({
    epics: [],
    archivedBeads: [bead("gone", "Archived loose", ["archived"])],
    expandedEpics: new Set<string>(),
    onToggleEpic: mock(() => {}),
    onBeadClick: mock(() => {}),
  })

  test("starts collapsed (hidden) with nothing stored", () => {
    render(<EpicTree {...props()} />)
    expect(screen.queryByText("Archived loose")).toBeNull()
  })

  test("expanded, then remounted: still expanded", () => {
    const first = render(<EpicTree {...props()} />)
    fireEvent.click(screen.getByText("Archived"))
    expect(screen.getByText("Archived loose")).toBeTruthy()
    first.unmount()
    render(<EpicTree {...props()} />)
    expect(screen.queryByText("Archived loose")).toBeTruthy()
  })

  test("collapsed again, then remounted: stays hidden", () => {
    const first = render(<EpicTree {...props()} />)
    fireEvent.click(screen.getByText("Archived"))
    fireEvent.click(screen.getByText("Archived"))
    first.unmount()
    render(<EpicTree {...props()} />)
    expect(screen.queryByText("Archived loose")).toBeNull()
  })
})
