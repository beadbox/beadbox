// beadbox-813: the Priority filter is a multi-select on the same control as
// the Status filter (components/multi-select-filter.tsx, extracted from the
// Status filter). An empty selection means "All Priority", never a blank
// list; the Status filter keeps its own semantics.

import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"

import { FilterBar } from "../components/filter-bar"
import { MultiSelectFilter } from "../components/multi-select-filter"
import type { BeadPriority, Filters } from "../lib/types"

afterEach(cleanup)

const STATUSES = ["open", "in_progress", "closed"] as Filters["status"]

function baseFilters(over: Partial<Filters> = {}): Filters {
  return {
    status: [...STATUSES],
    assignee: "all",
    priority: [],
    search: "",
    showMessages: false,
    showWaves: false,
    hasSpec: false,
    hasDeadline: false,
    rig: "all",
    grouped: false,
    ...over,
  }
}

// FilterBar driven like the app drives it: it reports changes, the parent
// stores them. `seen` records every Filters value the bar emitted.
function Harness({ initial, seen }: { initial: Filters; seen: Filters[] }) {
  const [filters, setFilters] = useState(initial)
  return (
    <FilterBar
      filters={filters}
      onFiltersChange={(f) => {
        seen.push(f)
        setFilters(f)
      }}
      assignees={[]}
      availableStatuses={[...STATUSES]}
    />
  )
}

const trigger = (name: string) => screen.getAllByRole("button", { name })[0]
const rowNames = () =>
  screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))

describe("Priority filter (beadbox-813)", () => {
  test("opens a checklist of All Priority then P0..P4", async () => {
    const user = userEvent.setup()
    render(<Harness initial={baseFilters()} seen={[]} />)
    expect(trigger("Priority filter").textContent).toContain("All Priority")
    await user.click(trigger("Priority filter"))
    expect(rowNames()).toEqual([
      "All Priority",
      "P0 - Critical",
      "P1 - High",
      "P2 - Medium",
      "P3 - Low",
      "P4 - Backlog",
    ])
  })

  test("several priorities can be selected; the label summarizes them", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(<Harness initial={baseFilters()} seen={seen} />)
    await user.click(trigger("Priority filter"))
    await user.click(screen.getByRole("checkbox", { name: "P0 - Critical" }).closest("button")!)
    expect(seen.at(-1)?.priority).toEqual(["critical"])
    expect(trigger("Priority filter").textContent).toContain("P0 - Critical")
    await user.click(screen.getByRole("checkbox", { name: "P1 - High" }).closest("button")!)
    expect(seen.at(-1)?.priority).toEqual(["critical", "high"])
    expect(trigger("Priority filter").textContent).toContain("2 priorities")
  })

  test("deselecting everything reads All Priority (no blank-list dead end)", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(<Harness initial={baseFilters({ priority: ["high"] })} seen={seen} />)
    await user.click(trigger("Priority filter"))
    await user.click(screen.getByRole("checkbox", { name: "P1 - High" }).closest("button")!)
    expect(seen.at(-1)?.priority).toEqual([])
    expect(trigger("Priority filter").textContent).toContain("All Priority")
  })

  test("selecting all five also reads All Priority", () => {
    const all: BeadPriority[] = ["critical", "high", "medium", "low", "backlog"]
    render(<Harness initial={baseFilters({ priority: all })} seen={[]} />)
    expect(trigger("Priority filter").textContent).toContain("All Priority")
  })

  test("the master row resets a narrowing selection to All", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(<Harness initial={baseFilters({ priority: ["critical", "high"] })} seen={seen} />)
    await user.click(trigger("Priority filter"))
    await user.click(screen.getByRole("checkbox", { name: "All Priority" }).closest("button")!)
    expect(seen.at(-1)?.priority).toEqual([])
    expect(trigger("Priority filter").textContent).toContain("All Priority")
  })

  test("keyboard only: Enter opens, arrows move, Space toggles, Escape closes", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(<Harness initial={baseFilters()} seen={seen} />)
    trigger("Priority filter").focus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("checkbox", { name: "P0 - Critical" })).toBeTruthy()
    // Focus starts on the first row (All Priority); ArrowDown twice → P1 - High.
    await user.keyboard("{ArrowDown}{ArrowDown}")
    expect(document.activeElement?.textContent).toBe("P1 - High")
    await user.keyboard(" ")
    expect(seen.at(-1)?.priority).toEqual(["high"])
    // ArrowUp wraps from the top to the last row; Home returns to the first.
    await user.keyboard("{Home}{ArrowUp}")
    expect(document.activeElement?.textContent).toBe("P4 - Backlog")
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("checkbox", { name: "P0 - Critical" })).toBeNull()
  })
})

describe("Status filter keeps its own behaviour on the shared control", () => {
  test("rows, the All toggle (none ↔ all) and the No Status label are unchanged", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(<Harness initial={baseFilters()} seen={seen} />)
    expect(trigger("Status filter").textContent).toContain("All Status")
    await user.click(trigger("Status filter"))
    expect(rowNames()).toEqual(["All Status", "Open", "In Progress", "Closed", "Grouped"])
    const all = () => screen.getByRole("checkbox", { name: "All Status" }).closest("button")!
    await user.click(all())
    expect(seen.at(-1)?.status).toEqual([])
    expect(trigger("Status filter").textContent).toContain("No Status")
    await user.click(all())
    expect(seen.at(-1)?.status).toEqual([...STATUSES])
  })

  test("Grouped stays in the Status dropdown", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(<Harness initial={baseFilters()} seen={seen} />)
    await user.click(trigger("Status filter"))
    await user.click(screen.getByRole("checkbox", { name: "Grouped" }).closest("button")!)
    expect(seen.at(-1)?.grouped).toBe(true)
  })
})

describe("MultiSelectFilter", () => {
  test("arrow keys move through the footer rows too", async () => {
    const user = userEvent.setup()
    render(
      <MultiSelectFilter
        triggerLabel="Pick"
        triggerClassName=""
        ariaLabel="Pick filter"
        allLabel="All"
        allState={true}
        onToggleAll={() => {}}
        options={[{ value: "a", label: "A" }]}
        selected={[]}
        onToggle={() => {}}
        footer={<button type="button" data-multi-select-row="">Extra</button>}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Pick filter" }))
    const list = screen.getByRole("dialog")
    within(list).getByText("All").closest("button")!.focus()
    await user.keyboard("{End}")
    expect(document.activeElement?.textContent).toBe("Extra")
  })
})
