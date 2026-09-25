import { afterEach, expect, test } from "bun:test"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { BeadDetailPanel } from "../components/bead-detail-panel"
import type { Bead } from "../lib/types"

afterEach(cleanup)

test("detail panel displays the complete issue fields after loading", async () => {
  const cached: Bead = {
    id: "gtp-mhb.6",
    type: "task",
    title: "Issue",
    description: "",
    status: "open",
    priority: "medium",
    assignee: "",
    comments: [],
  }
  const full: Bead = {
    ...cached,
    description: "Full description",
    acceptanceCriteria: "Acceptance text",
    notes: "Notes text",
    design: "Design text",
    assignee: "owner",
  }
  const props = { onClose: () => {}, onUpdate: () => {}, onAddComment: () => {} }
  const view = render(<BeadDetailPanel bead={cached} {...props} />)
  act(() => view.rerender(<BeadDetailPanel bead={full} {...props} />))
  await waitFor(() => expect(screen.getByText("Full description")).toBeTruthy())
  for (const text of ["Acceptance text", "Notes text", "Design text"])
    expect(screen.getByText(text)).toBeTruthy()
})
