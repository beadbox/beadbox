import { afterEach, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { BeadTable } from "../components/bead-table"
import { TooltipProvider } from "../components/ui/tooltip"
import { projectBeadKey } from "../lib/aggregate"
import type { Bead } from "../lib/types"

afterEach(cleanup)
const bead = (title: string, id = "same"): Bead => ({
  id,
  title,
  type: "task",
  description: "",
  status: "open",
  priority: "medium",
  assignee: "",
  comments: [],
})

test("table selection and deletion distinguish identical IDs", () => {
  const a = bead("Task A"),
    b = bead("Task B")
  const toggle = mock(() => {}),
    remove = mock(() => {})
  const { container } = render(
    <TooltipProvider>
      <BeadTable
        beads={[a, b]}
        epicId="_all"
        flat
        sourceForBead={(item) => ({
          id: item === a ? "a" : "b",
          name: item === a ? "Project A" : "Project B",
        })}
        onBeadClick={() => {}}
        onToggleSelect={toggle}
        onDelete={remove}
        selectedIds={new Set([projectBeadKey("a", "same")])}
      />
    </TooltipProvider>,
  )
  const rows = container.querySelectorAll<HTMLElement>("[data-bead-id]")
  expect(rows.length).toBe(2)
  expect(within(rows[0]).getByRole("checkbox").getAttribute("aria-checked")).toBe("true")
  expect(within(rows[1]).getByRole("checkbox").getAttribute("aria-checked")).toBe("false")
  expect(within(rows[1]).getByTestId("project-badge").textContent).toBe("Project B")
  fireEvent.click(within(rows[1]).getByRole("checkbox"))
  expect(toggle).toHaveBeenCalledWith(projectBeadKey("b", "same"))
  fireEvent.click(within(rows[1]).getByRole("button", { name: /delete/i }))
  expect(remove).toHaveBeenCalledWith(projectBeadKey("b", "same"))
})

test("wave calculation never resolves a blocker from another project", () => {
  const a = bead("Task A"),
    b = bead("Task B"),
    blocker = bead("Blocker A", "block")
  a.blockedBy = [{ id: "block", title: "Blocker A" }]
  b.blockedBy = [{ id: "block", title: "Absent B blocker" }]
  render(
    <TooltipProvider>
      <BeadTable
        beads={[a, b, blocker]}
        epicId="_all"
        flat
        showWaves
        sourceForBead={(item) => ({ id: item === b ? "b" : "a", name: "Project" })}
        onBeadClick={() => {}}
      />
    </TooltipProvider>,
  )
  const firstWave = screen.getByText("Wave 1").parentElement!.parentElement!
  const secondWave = screen.getByText("Wave 2").parentElement!.parentElement!
  expect(within(firstWave).getByText("Task B")).toBeTruthy()
  expect(within(secondWave).getByText("Task A")).toBeTruthy()
})
