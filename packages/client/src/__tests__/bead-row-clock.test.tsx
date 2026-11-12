import { afterEach, expect, setSystemTime, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { BeadTable } from "../components/bead-table"
import { TooltipProvider } from "../components/ui/tooltip"
import type { Bead } from "../lib/types"

afterEach(() => {
  cleanup()
  setSystemTime()
})

test("review: a row that passes its due time shows overdue on the next equal tree reply", () => {
  const start = new Date("2026-11-12T12:00:00Z")
  setSystemTime(start)
  const bead: Bead = {
    id: "due-1",
    title: "Due soon",
    type: "task",
    description: "",
    status: "open",
    priority: "medium",
    assignee: "",
    comments: [],
    dueAt: new Date(start.getTime() + 2 * 60_000),
  }
  const ui = (b: Bead) => (
    <TooltipProvider>
      <BeadTable beads={[b]} epicId="e" onBeadClick={() => {}} />
    </TooltipProvider>
  )
  const view = render(ui(bead))
  const icon = () =>
    view.container.querySelector("svg.lucide-calendar-clock")?.getAttribute("class") ?? "MISSING"
  expect(icon()).toContain("text-muted-foreground/50")
  setSystemTime(new Date(start.getTime() + 5 * 60_000))
  view.rerender(ui({ ...bead, dueAt: new Date(bead.dueAt as Date) }))
  expect(icon()).toContain("text-red-400")
})

test("gate deadline text advances on an equal tree reply", () => {
  const start = new Date("2026-11-12T12:00:00Z")
  setSystemTime(start)
  const bead: Bead = {
    id: "gate-1",
    title: "Wait for timer",
    type: "gate",
    description: "",
    status: "open",
    priority: "medium",
    assignee: "",
    comments: [],
    gateWait: {
      awaitType: "timer",
      deadline: new Date(start.getTime() + 2 * 60_000).toISOString(),
    },
  }
  const ui = (b: Bead) => <BeadTable beads={[b]} epicId="e" onBeadClick={() => {}} />
  const view = render(ui(bead))
  expect(view.container.textContent).toContain("expires in 2m")
  setSystemTime(new Date(start.getTime() + 5 * 60_000))
  view.rerender(ui({ ...bead, gateWait: { ...bead.gateWait! } }))
  expect(view.container.textContent).toContain("expired 3m ago")
})
