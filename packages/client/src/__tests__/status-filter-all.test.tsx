// beadbox-429 (GH #56, pm/spec §4.2): "All Status" means no status narrowing.
// With every listed status checked, a bead whose status is not in the list
// (bd's blocked/pinned/hooked, or a status the list has not caught up with)
// is still shown; unchecking any status narrows as before. The untouched
// default selection counts as every listed status, so a workspace whose beads
// are all in custom statuses is not empty at default filters.

import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"

import { FilterBar } from "../components/filter-bar"
import { filterEpics } from "../lib/epic-tree-utils"
import { getFiltersPreference } from "../lib/local-storage"
import type { Bead, Epic, Filters } from "../lib/types"

afterEach(cleanup)

const LISTED = ["open", "in_progress", "closed", "ticket_awaiting", "ticket_active", "unit_escalated"]

function filters(status: string[]): Filters {
  return {
    status,
    assignee: "all",
    priority: [],
    search: "",
    showMessages: false,
    showWaves: false,
    hasSpec: false,
    hasDeadline: false,
    rig: "all",
    grouped: false,
  }
}

function bead(id: string, status: string): Bead {
  return {
    id,
    title: `title ${id}`,
    type: "task",
    description: "",
    status,
    priority: "medium",
    assignee: "",
    comments: [],
  } as Bead
}

function tree(...beads: Bead[]): Epic[] {
  return [{ ...bead("_standalone", "open"), type: "epic", children: beads, childEpics: [] } as Epic]
}

const visible = (epics: Epic[]) => epics.flatMap((e) => e.children ?? []).map((b) => b.id)

const sample = () =>
  tree(bead("a", "ticket_awaiting"), bead("b", "ticket_active"), bead("u", "unit_escalated"), bead("x", "blocked"))

describe("status filter rule", () => {
  test("every listed status checked + a bead of an unlisted status: shown", () => {
    expect(visible(filterEpics(sample(), filters([...LISTED]), [], LISTED))).toEqual(["a", "b", "u", "x"])
  })

  test("one listed status unchecked + a bead of an unlisted status: hidden (narrowing as today)", () => {
    const some = LISTED.filter((s) => s !== "ticket_active")
    expect(visible(filterEpics(sample(), filters(some), [], LISTED))).toEqual(["a", "u"])
  })

  test("the default selection on a workspace of custom statuses shows every bead", () => {
    const defaults = getFiltersPreference().status
    expect(visible(filterEpics(sample(), filters([...defaults]), [], LISTED))).toEqual(["a", "b", "u", "x"])
  })

  test("nothing checked still shows nothing", () => {
    expect(visible(filterEpics(sample(), filters([]), [], LISTED))).toEqual([])
  })
})

function Harness({ initial, seen }: { initial: Filters; seen: Filters[] }) {
  const [f, setF] = useState(initial)
  return (
    <FilterBar
      filters={f}
      onFiltersChange={(next) => {
        seen.push(next)
        setF(next)
      }}
      assignees={[]}
      availableStatuses={LISTED}
    />
  )
}

describe("Status filter control", () => {
  test("at default filters it reads All Status, with the custom statuses checked", async () => {
    const user = userEvent.setup()
    render(<Harness initial={filters([...getFiltersPreference().status])} seen={[]} />)
    const trigger = screen.getAllByRole("button", { name: "Status filter" })[0]
    expect(trigger.textContent).toContain("All Status")
    await user.click(trigger)
    expect(screen.getByRole("checkbox", { name: "Ticket Active" }).getAttribute("aria-checked")).toBe("true")
  })

  test("unchecking one status from the default narrows to the rest of the listed statuses", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(<Harness initial={filters([...getFiltersPreference().status])} seen={seen} />)
    await user.click(screen.getAllByRole("button", { name: "Status filter" })[0])
    await user.click(screen.getByRole("checkbox", { name: "Ticket Active" }))
    const last = seen.at(-1)?.status ?? []
    for (const s of LISTED.filter((x) => x !== "ticket_active")) expect(last).toContain(s)
    expect(last).not.toContain("ticket_active")
    expect(visible(filterEpics(sample(), filters(last), [], LISTED))).not.toContain("b")
  })
})
