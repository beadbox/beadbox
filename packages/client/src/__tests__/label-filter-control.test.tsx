import { afterEach, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { FilterBar } from "../components/filter-bar"
import { getFiltersPreference } from "../lib/local-storage"
import type { Filters } from "../lib/types"

afterEach(async () => {
  await act(async () => cleanup())
})

test("label control toggles ANY choices, clears and refreshes its available labels", async () => {
  function Harness({ labels }: { labels: string[] }) {
    const [filters, setFilters] = useState<Filters>({ ...getFiltersPreference(), labels: [] })
    return (
      <>
        <FilterBar
          filters={filters}
          onFiltersChange={setFilters}
          assignees={[]}
          availableLabels={labels}
        />
        <output data-testid="selection">{JSON.stringify(filters.labels)}</output>
      </>
    )
  }
  const { rerender } = render(<Harness labels={["frontend", "urgent"]} />)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Label filter" })))
  const toggle = async (label: string) =>
    act(async () =>
      fireEvent.click(
        screen
          .getByRole("checkbox", { name: label })
          .closest("button[data-multi-select-row]") as HTMLElement,
      ),
    )
  await toggle("frontend")
  await toggle("urgent")
  expect(screen.getByTestId("selection").textContent).toBe('["frontend","urgent"]')
  await toggle("frontend")
  expect(screen.getByTestId("selection").textContent).toBe('["urgent"]')
  // A selected label remains removable even if bd no longer returns it.
  await act(async () => rerender(<Harness labels={["frontend", "live"]} />))
  expect(screen.getByRole("checkbox", { name: "urgent" })).toBeTruthy()
  expect(screen.getByRole("checkbox", { name: "live" })).toBeTruthy()
  await toggle("All Labels")
  expect(screen.getByTestId("selection").textContent).toBe("[]")
})
