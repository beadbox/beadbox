// beadbox-816g.1: the three places a due value appears render it through the
// shared formatter, so none can drift back to its own month-and-day format.
//
// Due values are built as LOCAL instants (new Date(y, m, d, h, min)) so the
// expected text holds in any machine zone without touching process.env.TZ.

import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { BeadExpandedViewModal } from "../components/bead-expanded-view-modal"
import { SchedulingControls } from "../components/bead-scheduling-controls"
import { BeadTable } from "../components/bead-table"
import type { Bead } from "../lib/types"

afterEach(cleanup)

const TIMED = new Date(2026, 9, 28, 0, 30)
const MIDNIGHT = new Date(2026, 9, 28, 0, 0)

const CASES = [
  { name: "timed", dueAt: TIMED, text: "Due: Oct 28, 12:30 AM" },
  { name: "midnight", dueAt: MIDNIGHT, text: "Due: Oct 28" },
]

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

describe("due value on each surface (beadbox-816g.1)", () => {
  for (const c of CASES) {
    test(`bead table row tooltip: ${c.name}`, () => {
      const { container } = render(
        <BeadTable beads={[bead(c.dueAt)]} epicId="root" onBeadClick={() => {}} />,
      )
      const trigger = container.querySelector("svg.lucide-calendar-clock")
      expect(trigger).toBeTruthy()
      fireEvent.focus(trigger as Element)
      expect(screen.getAllByText(dueText(c.text)).length).toBeGreaterThan(0)
    })

    test(`detail panel due control: ${c.name}`, () => {
      render(
        <SchedulingControls
          dueAt={c.dueAt}
          fieldStates={{ dueAt: idle, deferUntil: idle, estimatedMinutes: idle }}
          onSaveDue={() => {}}
          onSaveDefer={() => {}}
          onSaveEstimate={() => {}}
          isMobile={false}
        />,
      )
      expect(screen.getByText(dueText(c.text))).toBeTruthy()
    })

    test(`expanded view: ${c.name}`, () => {
      render(
        <BeadExpandedViewModal
          open
          onOpenChange={() => {}}
          bead={bead(c.dueAt)}
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
          dueAt={c.dueAt}
          commentSort="newest"
          onSortChange={() => {}}
          groupedComments={[]}
          onRemoveDependency={() => {}}
        />,
      )
      expect(screen.getByText(dueText(c.text))).toBeTruthy()
    })
  }
})
