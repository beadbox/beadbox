// Bead data is repository-controlled, so the Chart view must stay bounded
// whatever it holds (beadbox-8wz, sec FIX-A and L-1): a huge estimate, a
// decades-old date or a very long blocker chain must not stretch the timeline
// into millions of ticks, and must not throw.

import { describe, expect, test } from "bun:test"
import { buildGanttModel } from "@/lib/gantt-model"
import { HOUR_MS, ticks } from "@/lib/gantt-scale"
import type { Bead, Epic, Filters } from "@/lib/types"

const FILTERS: Filters = {
  status: ["open", "in_progress", "closed", "blocked", "deferred"],
  assignee: "all",
  priority: "all",
  showMessages: false,
  showWaves: false,
  hasSpec: false,
  hasDeadline: false,
  search: "",
  rig: "all",
  grouped: false,
}

const NOW = Date.parse("2026-10-06T12:00:00Z")
const YEAR_MS = 365 * 24 * HOUR_MS
// The window bars are clamped into, and the most ticks one axis may hold.
const WINDOW_MS = 5 * YEAR_MS
const TICK_CAP = 2_000

function bead(id: string, extra: Partial<Bead> = {}): Bead {
  return {
    id,
    type: "task",
    title: `Title ${id}`,
    description: "",
    status: "open",
    priority: "medium",
    assignee: "",
    comments: [],
    createdAt: new Date(NOW - 24 * HOUR_MS),
    updatedAt: new Date(NOW - 24 * HOUR_MS),
    ...extra,
  }
}

const epic = (id: string, children: Bead[]): Epic => ({ ...bead(id, { type: "epic" }), children, childEpics: [] })

function expectInsideWindow(extent: { start: number; end: number } | null): void {
  expect(extent).not.toBeNull()
  expect(extent!.start).toBeGreaterThanOrEqual(NOW - WINDOW_MS)
  expect(extent!.end).toBeLessThanOrEqual(NOW + WINDOW_MS)
}

describe("hostile bead times stay inside the timeline window", () => {
  test("an estimate of 2e9 minutes does not stretch the plan", () => {
    const m = buildGanttModel([epic("E", [bead("a", { estimatedMinutes: 2e9 })])], {}, FILTERS, NOW)
    expectInsideWindow(m.extent)
  })

  test("non-finite and negative estimates fall back to the default", () => {
    for (const estimatedMinutes of [Number.POSITIVE_INFINITY, Number.NaN, -5]) {
      const m = buildGanttModel([epic("E", [bead("a", { estimatedMinutes })])], {}, FILTERS, NOW)
      const bar = m.sections[0].rows[0].bar!
      expect(bar.end - bar.start).toBe(HOUR_MS)
    }
  })

  test("a bead created in 1970 does not stretch the history", () => {
    const old = new Date(0)
    const m = buildGanttModel(
      [epic("E", [bead("a", { status: "in_progress", createdAt: old, updatedAt: old })])],
      {},
      FILTERS,
      NOW,
    )
    expectInsideWindow(m.extent)
  })

  test("a start or close far in the future is clamped too", () => {
    const far = new Date(NOW + 1_000 * YEAR_MS)
    const m = buildGanttModel(
      [epic("E", [bead("a", { status: "closed", startedAt: new Date(NOW), closedAt: far, updatedAt: far })])],
      {},
      FILTERS,
      NOW,
    )
    expectInsideWindow(m.extent)
  })
})

describe("ticks are capped", () => {
  test("a 1,000-year domain at hours yields at most the cap", () => {
    const out = ticks({ start: NOW - 500 * YEAR_MS, end: NOW + 500 * YEAR_MS }, "hours")
    expect(out.length).toBeLessThanOrEqual(TICK_CAP)
  }, 30_000)
})

describe("long blocker chains", () => {
  test("a 5,000-bead chain builds without throwing, each bead after its blocker", () => {
    const n = 5_000
    const beads = Array.from({ length: n }, (_, i) => bead(`c${i}`))
    const blockedBy: Record<string, string[]> = {}
    for (let i = 1; i < n; i++) blockedBy[`c${i}`] = [`c${i - 1}`]
    const m = buildGanttModel([epic("E", beads)], blockedBy, FILTERS, NOW)
    const rows = m.sections[0].rows
    expect(rows).toHaveLength(n)
    expect(rows[1].bar!.start).toBeGreaterThanOrEqual(rows[0].bar!.end)
    expect(rows[n - 1].bar!.start).toBeGreaterThanOrEqual(rows[n - 2].bar!.end)
  })

  test("an epic used as a blocker, behind a long chain, also builds", () => {
    const n = 3_000
    const inner = Array.from({ length: n }, (_, i) => bead(`k${i}`))
    const blockedBy: Record<string, string[]> = { after: ["E"] }
    for (let i = 1; i < n; i++) blockedBy[`k${i}`] = [`k${i - 1}`]
    const m = buildGanttModel([epic("E", inner), epic("F", [bead("after")])], blockedBy, FILTERS, NOW)
    const after = m.sections[1].rows[0].bar!
    expect(after.start).toBeGreaterThanOrEqual(m.sections[0].bar!.end)
  })
})

describe("bead ids that name Object.prototype members", () => {
  test("constructor / toString / __proto__ ids do not break the model", () => {
    const ids = ["constructor", "toString", "__proto__", "hasOwnProperty"]
    const beads = ids.map((id) => bead(id))
    const m = buildGanttModel([epic("E", beads)], { other: ["constructor"] }, FILTERS, NOW)
    expect(m.sections[0].rows.map((r) => r.bead.id)).toEqual(ids)
    expect(m.edges).toEqual([])
  })
})
