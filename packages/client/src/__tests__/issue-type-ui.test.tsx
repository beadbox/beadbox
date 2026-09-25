import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { BeadTable } from "../components/bead-table"
import { BeadDetailPanel } from "../components/bead-detail-panel"
import type { Bead } from "../lib/types"
import { isMoleculePresentation } from "../lib/molecule-presentation"
import { filterEpics, findBeadById, findParentPath, flattenEpicsToBeads } from "../lib/epic-tree-utils"
import type { Epic, Filters } from "../lib/types"

afterEach(cleanup)

describe("issue type display", () => {
  test("renders and filters decision → epic → epic → task without duplicate rows", () => {
    const task: Bead = { id: "task-1", type: "task", title: "Leaf task", description: "", status: "open", priority: "medium", assignee: "", comments: [] }
    const nestedEpic: Epic = { ...task, id: "epic-2", type: "epic", title: "Nested epic", children: [task] }
    const innerEpic: Epic = { ...task, id: "epic-1", type: "epic", title: "Inner epic", children: [nestedEpic] }
    const decision: Bead = { ...task, id: "decision-1", type: "decision", title: "Decision", children: [innerEpic] }
    const root: Epic = { ...task, id: "_standalone", type: "epic", title: "Standalone", children: [decision] }
    const filters: Filters = { status: ["open"], assignee: "all", priority: "all", search: "", showMessages: false, showWaves: false, hasSpec: false, hasDeadline: false, rig: "all", grouped: false, type: "task" }
    const filtered = filterEpics([root], filters)
    expect(findBeadById(filtered, "task-1")?.title).toBe("Leaf task")
    expect(findParentPath(filtered, "task-1")?.map((parent) => parent.id)).toEqual(["_standalone", "decision-1", "epic-1", "epic-2"])
    expect(flattenEpicsToBeads(filtered).map((bead) => bead.id)).toEqual(["decision-1", "epic-1", "epic-2", "task-1"])
    const { container } = render(<BeadTable beads={[decision]} epicId="_standalone" expandedBeads={new Set(["decision-1", "epic-1", "epic-2"])} onBeadClick={() => {}} />)
    expect(container.querySelectorAll('[data-item-id="task-1"]')).toHaveLength(1)
    expect(screen.getByText("Nested epic")).toBeTruthy()
  })

  test("keeps the current type visible but disables mutation without a catalog", () => {
    const bead: Bead = {
      id: "bb-2", type: "decision", title: "Choose transport", description: "",
      status: "open", priority: "medium", assignee: "", comments: [],
    }
    render(<BeadDetailPanel bead={bead} onClose={() => {}} onUpdate={() => {}} onAddComment={() => {}} availableTypes={["task", "decision"]} typeCatalogReady={false} />)
    const typeButton = screen.getByRole("button", { name: "decision" }) as HTMLButtonElement
    expect(typeButton.disabled).toBe(true)
  })

  test("recognizes real and legacy molecule roots without changing their type", () => {
    expect(isMoleculePresentation({ id: "bb-1", type: "molecule" })).toBe(true)
    expect(isMoleculePresentation({ id: "bb-mol-1", type: "epic" })).toBe(true)
    expect(isMoleculePresentation({ id: "bb-mol-1", type: "task" })).toBe(false)
  })
  test("shows an unknown workspace type by its exact name", () => {
    const bead: Bead = {
      id: "bb-1",
      type: "decision",
      title: "Choose transport",
      description: "",
      status: "open",
      priority: "medium",
      assignee: "",
      comments: [],
    }
    render(<BeadTable beads={[bead]} epicId="root" onBeadClick={() => {}} />)
    expect(screen.getByText("decision")).toBeTruthy()
    expect(screen.queryByText("Unknown")).toBeNull()
  })
})
