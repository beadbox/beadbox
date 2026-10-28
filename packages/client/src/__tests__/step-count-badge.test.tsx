// The step header's closed/total badge (beadbox-ptca.4): it shows the count the
// Formulas view provides for that step, and nothing when there is none (no
// molecule selected, a flat formula, or a step bd did not pour).

import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { StepCountBadge, StepCountsContext } from "../components/step-count-badge"

afterEach(cleanup)

const withCounts = (counts: Record<string, { closed: number; total: number }> | null, stepId: string) =>
  render(
    <StepCountsContext.Provider value={counts}>
      <StepCountBadge stepId={stepId} />
    </StepCountsContext.Provider>,
  )

describe("StepCountBadge (beadbox-ptca.4)", () => {
  test("shows closed/total for its step", () => {
    withCounts({ s1: { closed: 3, total: 7 }, s2: { closed: 0, total: 1 } }, "s1")
    expect(screen.getByTestId("step-count").textContent).toBe("3/7")
  })

  test("a zero-child step shows 0/0", () => {
    withCounts({ s3: { closed: 0, total: 0 } }, "s3")
    expect(screen.getByTestId("step-count").textContent).toBe("0/0")
  })

  test("no count for the step, or no counts at all: nothing rendered", () => {
    withCounts({ s1: { closed: 1, total: 2 } }, "other")
    withCounts(null, "s1")
    expect(screen.queryByTestId("step-count")).toBeNull()
  })
})
