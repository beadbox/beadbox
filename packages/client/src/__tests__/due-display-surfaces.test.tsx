// beadbox-816g.1/.2: the three places a due value appears render it through
// the shared formatter, so none can drift back to its own format or keep a
// private overdue test.
//
// Format cases use LOCAL instants far in the future (new Date(2099, ...)) so
// the text holds in any machine zone and carries no hint. Hint and overdue
// cases are relative to the real clock with 30 min of slack, so no global
// clock mock crosses files.

import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { BeadExpandedViewModal } from "../components/bead-expanded-view-modal"
import { SchedulingControls } from "../components/bead-scheduling-controls"
import { BeadTable } from "../components/bead-table"
import { formatDueAt } from "../lib/due-format"
import type { Bead } from "../lib/types"

afterEach(cleanup)

const HOUR = 3_600_000

const bead = (dueAt: Date): Bead => ({
  id: "bb-due",
  type: "task",
  title: "Push the release",
  description: "",
  status: "open",
  priority: "medium",
  assignee: "",
  comments: [],
  dueAt,
})

const idle = { isSaving: false, hasError: false }

// Text split across nodes ("Due:", " ", "Oct 28") is matched on the element.
const dueText = (text: string) => (_: string, el: Element | null) =>
  el?.textContent?.trim() === text &&
  !Array.from(el.children).some((child) => child.textContent?.trim() === text)

// Each surface renders the due value and returns the element carrying its
// red/blue/muted styling, after the due text is on screen.
const SURFACES: { name: string; mount: (dueAt: Date) => Element }[] = [
  {
    name: "bead table row tooltip",
    mount: (dueAt) => {
      const { container } = render(
        <BeadTable beads={[bead(dueAt)]} epicId="root" onBeadClick={() => {}} />,
      )
      const icon = container.querySelector("svg.lucide-calendar-clock")
      expect(icon).toBeTruthy()
      fireEvent.focus(icon as Element)
      return icon as Element
    },
  },
  {
    name: "detail panel due control",
    mount: (dueAt) => {
      render(
        <SchedulingControls
          dueAt={dueAt}
          fieldStates={{ dueAt: idle, deferUntil: idle, estimatedMinutes: idle }}
          onSaveDue={() => {}}
          onSaveDefer={() => {}}
          onSaveEstimate={() => {}}
          isMobile={false}
        />,
      )
      return screen.getByRole("button", { name: /^Due:/ })
    },
  },
  {
    name: "expanded view",
    mount: (dueAt) => {
      render(
        <BeadExpandedViewModal
          open
          onOpenChange={() => {}}
          bead={bead(dueAt)}
          type="task"
          status="open"
          priority="medium"
          assignee=""
          labels={[]}
          specId=""
          description=""
          design=""
          acceptanceCriteria=""
          notes=""
          dueAt={dueAt}
          commentSort="newest"
          onSortChange={() => {}}
          groupedComments={[]}
          onRemoveDependency={() => {}}
        />,
      )
      // The dialog portals into document.body; the due span wraps its icon.
      const span = document.body.querySelector("svg.lucide-calendar-clock")?.parentElement
      expect(span).toBeTruthy()
      return span as Element
    },
  },
]

const expectDueText = (text: string) =>
  expect(screen.getAllByText(dueText(text)).length).toBeGreaterThan(0)

describe("due value on each surface (beadbox-816g.1)", () => {
  const CASES = [
    { name: "timed", dueAt: new Date(2099, 9, 28, 0, 30), text: "Due: Oct 28, 12:30 AM" },
    { name: "midnight", dueAt: new Date(2099, 9, 28, 0, 0), text: "Due: Oct 28" },
  ]
  for (const s of SURFACES) {
    for (const c of CASES) {
      test(`${s.name}: ${c.name}`, () => {
        s.mount(c.dueAt)
        expectDueText(c.text)
      })
    }
  }
})

describe("hint and overdue on each surface (beadbox-816g.2)", () => {
  for (const s of SURFACES) {
    test(`${s.name}: due in 3 h shows the hint and is not red`, () => {
      const dueAt = new Date(Date.now() + 3.5 * HOUR)
      const styled = s.mount(dueAt)
      expectDueText(`Due: ${formatDueAt(dueAt)} · in 3 h`)
      expect(styled.getAttribute("class")).not.toContain("red")
    })

    test(`${s.name}: past due shows overdue in red`, () => {
      const dueAt = new Date(Date.now() - 7 * 24 * HOUR)
      const styled = s.mount(dueAt)
      expectDueText(`Due: ${formatDueAt(dueAt)} · overdue`)
      expect(styled.getAttribute("class")).toContain("text-red-400")
    })
  }
})
