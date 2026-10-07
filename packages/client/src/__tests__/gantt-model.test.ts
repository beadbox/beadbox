import { describe, expect, test } from "bun:test"
import { buildGanttModel, type GanttSection } from "@/lib/gantt-model"
import type { Bead, Epic, Filters } from "@/lib/types"

const ALL_STATUSES = ["open", "in_progress", "closed", "blocked", "deferred", "ready_for_qa"]

const FILTERS: Filters = {
  status: ALL_STATUSES,
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
const HOUR = 3_600_000
const day = (n: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 86_400_000)

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
    createdAt: day(0),
    updatedAt: day(0),
    ...extra,
  }
}

function epic(id: string, children: Bead[], childEpics: Epic[] = [], extra: Partial<Bead> = {}): Epic {
  return { ...bead(id, { type: "epic", ...extra }), children, childEpics }
}

const model = (epics: Epic[], filters: Filters = FILTERS, blockedBy: Record<string, string[]> | null = {}) =>
  buildGanttModel(epics, blockedBy, filters, NOW)

const rowIds = (s: GanttSection) => s.rows.map((r) => r.bead.id)

describe("buildGanttModel — sections", () => {
  test("nests child epics as subsections and subtasks as indented rows", () => {
    const m = model([
      epic("A", [bead("a1", { children: [bead("a1x")] })], [epic("A1", [bead("x")])]),
    ])
    expect(m.sections.map((s) => s.id)).toEqual(["A"])
    const [A] = m.sections
    expect(rowIds(A)).toEqual(["a1", "a1x"])
    expect(A.rows.map((r) => r.depth)).toEqual([0, 1])
    expect(A.sections.map((s) => [s.id, s.depth])).toEqual([["A1", 1]])
    expect(rowIds(A.sections[0])).toEqual(["x"])
  })

  test("leaves out archived epics with their subtree, and archived beads", () => {
    const m = model([
      epic("A", [bead("keep"), bead("gone", { labels: ["archived"] })], [epic("A1", [bead("deep")], [], { labels: ["archived"] })]),
      epic("B", [bead("b1")], [], { labels: ["archived"] }),
    ])
    expect(m.sections.map((s) => s.id)).toEqual(["A"])
    expect(rowIds(m.sections[0])).toEqual(["keep"])
    expect(m.sections[0].sections).toEqual([])
  })

  test("keeps backlogged epics as normal sections", () => {
    const m = model([epic("BL", [bead("b")], [], { priority: "backlog" })])
    expect(m.sections.map((s) => s.id)).toEqual(["BL"])
  })

  test("puts beads without an epic in a last section titled Ungrouped", () => {
    const m = model([epic("_standalone", [bead("loose")]), epic("A", [bead("a1")])])
    expect(m.sections.map((s) => [s.id, s.title])).toEqual([
      ["A", "Title A"],
      ["_standalone", "Ungrouped"],
    ])
    expect(m.sections[1].epic).toBeNull()
  })

  test("applies the shared filters and hides sections with nothing matching", () => {
    const filters = { ...FILTERS, assignee: "alice" }
    const m = model(
      [
        epic("A", [bead("mine", { assignee: "alice" }), bead("theirs", { assignee: "bob" })]),
        epic("B", [bead("other", { assignee: "bob" })]),
      ],
      filters,
    )
    expect(m.sections.map((s) => s.id)).toEqual(["A"])
    expect(rowIds(m.sections[0])).toEqual(["mine"])
  })
})

describe("buildGanttModel — bar timing and style", () => {
  const rowsOf = (beads: Bead[]) => model([epic("A", beads)]).sections[0].rows
  const barOf = (b: Bead) => rowsOf([b])[0].bar!

  test("starts at bd's started_at when present; a not-started bead without blockers starts now", () => {
    expect(barOf(bead("s", { status: "in_progress", startedAt: day(2) })).start).toBe(day(2).getTime())
    expect(barOf(bead("c", { status: "open" })).start).toBe(NOW)
  })

  test("a closed bar ends at closed_at; a started one at now; a not-started one after its planned length", () => {
    expect(barOf(bead("d", { status: "closed", closedAt: day(3) })).end).toBe(day(3).getTime())
    expect(barOf(bead("w", { status: "in_progress" })).end).toBe(NOW)
    expect(barOf(bead("o", { status: "open" })).end).toBe(NOW + HOUR)
  })

  test("a running bar grows with now", () => {
    const b = bead("w", { status: "in_progress" })
    const later = buildGanttModel([epic("A", [b])], {}, FILTERS, NOW + 3_600_000)
    expect(later.sections[0].rows[0].bar!.end).toBe(NOW + 3_600_000)
  })

  test("style: open/deferred waiting, blocked, other non-closed working, closed done", () => {
    const styles = rowsOf([
      bead("o", { status: "open" }),
      bead("f", { status: "deferred" }),
      bead("b", { status: "blocked" }),
      bead("w", { status: "in_progress" }),
      bead("q", { status: "ready_for_qa" }),
      bead("d", { status: "closed", closedAt: day(1) }),
    ]).map((r) => r.bar!.style)
    expect(styles).toEqual(["waiting", "waiting", "blocked", "working", "working", "done"])
  })

  test("a bead blocked after starting keeps its start and is drawn blocked", () => {
    const bar = barOf(bead("b", { status: "blocked", startedAt: day(2) }))
    expect(bar).toEqual({ start: day(2).getTime(), end: NOW, style: "blocked" })
  })

  // beadbox-8wz: bd stamps started_at on in_progress and --claim only, so a
  // bead moved straight to a custom status, or closed from open, has none.
  test("a bar with bd's start is recorded; a started or closed bead without one is inferred", () => {
    const [recorded, custom, closed, open] = rowsOf([
      bead("r", { status: "in_progress", startedAt: day(2) }),
      bead("q", { status: "ready_for_qa", createdAt: day(1) }),
      bead("d", { status: "closed", createdAt: day(1), closedAt: day(3) }),
      bead("o", { status: "open" }),
    ]).map((r) => r.bar!)
    expect(recorded.inferred).toBeUndefined()
    expect(custom).toEqual({ start: day(1).getTime(), end: NOW, style: "working", inferred: true })
    expect(closed).toEqual({ start: day(1).getTime(), end: day(3).getTime(), style: "done", inferred: true })
    expect(open.inferred).toBeUndefined() // planned, drawn in the planned style
  })

  test("an unparseable start time counts as no start", () => {
    const bar = barOf(bead("x", { status: "in_progress", startedAt: new Date("garbage"), createdAt: day(1) }))
    expect(bar).toEqual({ start: day(1).getTime(), end: NOW, style: "working", inferred: true })
  })
})

describe("buildGanttModel — summary bars", () => {
  test("an epic's summary spans the earliest start to the latest end inside it, nested epics included", () => {
    const m = model([
      epic(
        "A",
        [bead("a", { status: "closed", createdAt: day(1), closedAt: day(2) })],
        [epic("A1", [bead("x", { status: "closed", createdAt: day(3), closedAt: day(5) })])],
      ),
    ])
    const [A] = m.sections
    expect(A.barKind).toBe("summary")
    expect([A.bar!.start, A.bar!.end]).toEqual([day(1).getTime(), day(5).getTime()])
    expect(m.extent).toEqual({ start: day(1).getTime(), end: day(5).getTime() })
  })

  test("an epic with nothing visible inside shows its own bar", () => {
    const m = model([epic("E", [], [], { status: "in_progress", startedAt: day(4) })])
    const [E] = m.sections
    expect(E.barKind).toBe("own")
    expect(E.bar).toEqual({ start: day(4).getTime(), end: NOW, style: "working" })
  })
})

describe("buildGanttModel — dependencies", () => {
  test("a dependency inside one section becomes an arrow", () => {
    const m = model([epic("A", [bead("a"), bead("b")])], FILTERS, { b: ["a"] })
    expect(m.edges).toEqual([{ from: "a", to: "b" }])
    expect(m.markers).toEqual({})
  })

  test("a dependency across sections becomes a marker on both bars, with no arrow", () => {
    const m = model([epic("A", [bead("a")]), epic("B", [bead("b")])], FILTERS, { b: ["a"] })
    expect(m.edges).toEqual([])
    expect(m.markers.b).toEqual([{ otherId: "a", otherTitle: "Title a", relation: "blocked-by" }])
    expect(m.markers.a).toEqual([{ otherId: "b", otherTitle: "Title b", relation: "blocks" }])
  })

  test("a blocker that is not shown still gives the blocked bead a marker naming it", () => {
    const filters = { ...FILTERS, status: ["open"] }
    const m = model([epic("A", [bead("a", { status: "closed", closedAt: day(1) }), bead("b")])], filters, { b: ["a"] })
    expect(m.edges).toEqual([])
    expect(m.markers.b).toEqual([{ otherId: "a", otherTitle: "Title a", relation: "blocked-by" }])
  })

  test("missing dependency data gives no arrows or markers and is flagged", () => {
    const m = model([epic("A", [bead("a"), bead("b")])], FILTERS, null)
    expect(m.edges).toEqual([])
    expect(m.markers).toEqual({})
    expect(m.dependenciesDegraded).toBe(true)
    expect(model([epic("A", [bead("a")])]).dependenciesDegraded).toBe(false)
  })
})

describe("buildGanttModel — cross edges (PR #53)", () => {
  test("a dependency across sections is kept as a cross edge, with the same markers as before", () => {
    const m = model([epic("A", [bead("a")]), epic("B", [bead("b")])], FILTERS, { b: ["a"] })
    expect(m.crossEdges).toEqual([{ from: "a", to: "b" }])
    expect(m.edges).toEqual([])
    expect(m.markers.b).toEqual([{ otherId: "a", otherTitle: "Title a", relation: "blocked-by" }])
    expect(m.markers.a).toEqual([{ otherId: "b", otherTitle: "Title b", relation: "blocks" }])
  })

  test("a blocker hidden by filters gives a marker but no cross edge", () => {
    const filters = { ...FILTERS, assignee: "alice" }
    const m = model([epic("A", [bead("a")]), epic("B", [bead("b", { assignee: "alice" })])], filters, { b: ["a"] })
    expect(m.crossEdges).toEqual([])
    expect(m.markers.b).toEqual([{ otherId: "a", otherTitle: "Title a", relation: "blocked-by" }])
  })

  test("same-section and missing dependency data give no cross edges", () => {
    expect(model([epic("A", [bead("a"), bead("b")])], FILTERS, { b: ["a"] }).crossEdges).toEqual([])
    expect(model([epic("A", [bead("a")]), epic("B", [bead("b")])], FILTERS, null).crossEdges).toEqual([])
  })
})

describe("buildGanttModel — dependency scheduling (design D12)", () => {
  const rowBar = (m: ReturnType<typeof model>, id: string) =>
    m.sections.flatMap(function rows(sec): GanttSection["rows"] {
      return [...sec.rows, ...sec.sections.flatMap(rows)]
    }).find((r) => r.bead.id === id)!.bar!
  const running = (id: string, startDay: number) =>
    bead(id, { status: "in_progress", startedAt: day(startDay) })

  test("a recorded start is kept, whatever its blockers do", () => {
    const m = model([epic("A", [running("a", 3), bead("b", { status: "in_progress", startedAt: day(1) })])], FILTERS, { b: ["a"] })
    expect(rowBar(m, "b").start).toBe(day(1).getTime())
  })

  test("a finished bead without a recorded start starts after its blocker, capped at its close", () => {
    const m = model(
      [
        epic("A", [
          bead("a", { status: "closed", createdAt: day(0), closedAt: day(2) }),
          bead("b", { status: "closed", createdAt: day(0), closedAt: day(4) }),
          bead("c", { status: "closed", createdAt: day(0), closedAt: day(1) }), // closed before its blocker did
        ]),
      ],
      FILTERS,
      { b: ["a"], c: ["a"] },
    )
    expect(rowBar(m, "b")).toEqual({ start: day(2).getTime(), end: day(4).getTime(), style: "done", inferred: true })
    expect(rowBar(m, "c").start).toBe(day(1).getTime())
  })

  test("one blocker: a not-started bead starts where its running blocker ends (now)", () => {
    const m = model([epic("A", [running("a", 1), bead("b")])], FILTERS, { b: ["a"] })
    expect(rowBar(m, "a").end).toBe(NOW)
    expect(rowBar(m, "b")).toEqual({ start: NOW, end: NOW + HOUR, style: "waiting" })
  })

  test("several blockers: starts after the latest one finishes", () => {
    const m = model(
      [epic("A", [bead("a", { estimatedMinutes: 30 }), bead("b", { estimatedMinutes: 120 }), bead("c")])],
      FILTERS,
      { c: ["a", "b"] },
    )
    expect(rowBar(m, "c").start).toBe(NOW + 2 * HOUR)
  })

  test("a chain propagates: each bead starts when the one before it ends", () => {
    const m = model([epic("A", [running("a", 1), bead("b"), bead("c", { status: "blocked" })])], FILTERS, {
      b: ["a"],
      c: ["b"],
    })
    expect(rowBar(m, "b").start).toBe(NOW)
    expect(rowBar(m, "c")).toEqual({ start: NOW + HOUR, end: NOW + 2 * HOUR, style: "blocked" })
  })

  test("independent beads stay in parallel", () => {
    const m = model([epic("A", [bead("a"), bead("b")])])
    expect(rowBar(m, "a").start).toBe(NOW)
    expect(rowBar(m, "b").start).toBe(NOW)
  })

  test("planned length is the estimate, else one hour", () => {
    const m = model([epic("A", [bead("e", { estimatedMinutes: 90 }), bead("n")])])
    expect(rowBar(m, "e").end - rowBar(m, "e").start).toBe(90 * 60_000)
    expect(rowBar(m, "n").end - rowBar(m, "n").start).toBe(HOUR)
  })

  test("a blocker hidden by filters still counts", () => {
    const filters = { ...FILTERS, assignee: "alice" }
    const m = model([epic("A", [bead("a", { estimatedMinutes: 120 }), bead("b", { assignee: "alice" })])], filters, {
      b: ["a"],
    })
    expect(rowIds(m.sections[0])).toEqual(["b"])
    expect(rowBar(m, "b").start).toBe(NOW + 2 * HOUR)
  })

  test("a dependency cycle is broken instead of hanging", () => {
    const m = model([epic("A", [bead("a"), bead("b")])], FILTERS, { a: ["b"], b: ["a"] })
    const [a, b] = [rowBar(m, "a"), rowBar(m, "b")]
    expect(Math.max(a.start, b.start)).toBe(NOW + HOUR) // one of them goes first
  })

  test("without dependency data nothing is scheduled after anything", () => {
    const m = model([epic("A", [running("a", 1), bead("b")])], FILTERS, null)
    expect(rowBar(m, "b").start).toBe(NOW)
    expect(m.dependenciesDegraded).toBe(true)
  })

  test("the extent includes planned future time", () => {
    const m = model([epic("A", [running("a", 1), bead("b", { estimatedMinutes: 180 })])], FILTERS, { b: ["a"] })
    expect(m.extent!.end).toBe(NOW + 3 * HOUR)
  })
})

describe("buildGanttModel — blockers inherited from epics (beadbox-aqn, design D6)", () => {
  const rowBar = (m: ReturnType<typeof model>, id: string) =>
    m.sections.flatMap(function rows(sec): GanttSection["rows"] {
      return [...sec.rows, ...sec.sections.flatMap(rows)]
    }).find((r) => r.bead.id === id)!.bar!
  const running = (id: string, startDay: number) =>
    bead(id, { status: "in_progress", startedAt: day(startDay) })

  test("a group blocked by a group: its not-started tasks start after the other group's last bar", () => {
    const g1 = epic("G1", [running("a", 1), bead("b", { estimatedMinutes: 120 })])
    const g2 = epic("G2", [bead("t")])
    const m = model([g1, g2], FILTERS, { b: ["a"], G2: ["G1"] })
    // G1's last bar is b's planned window, ending now + 2h.
    expect(rowBar(m, "t").start).toBe(NOW + 2 * HOUR)
  })

  test("nested epics: a bead waits for the blocker of an epic further up", () => {
    const outer = epic("E", [bead("x", { estimatedMinutes: 180 })], [epic("E1", [bead("t")])])
    const m = model([outer, epic("B", [bead("blocker", { estimatedMinutes: 90 })])], FILTERS, { E1: [], E: ["blocker"] })
    expect(rowBar(m, "t").start).toBe(NOW + 90 * 60_000)
  })

  test("a recorded start wins over an inherited blocker", () => {
    const m = model([epic("G1", [bead("a", { estimatedMinutes: 120 })]), epic("G2", [running("t", 2)])], FILTERS, {
      G2: ["G1"],
    })
    expect(rowBar(m, "t").start).toBe(day(2).getTime())
  })

  test("an epic blocked by its own child does not hang", () => {
    const m = model([epic("E", [bead("c"), bead("d")])], FILTERS, { E: ["c"] })
    expect(rowBar(m, "c").start).toBe(NOW)
    expect(rowBar(m, "d").start).toBe(NOW + HOUR) // d inherits E's blocker c
  })

  test("an empty epic used as a blocker finishes at the end of its own bar", () => {
    const m = model([epic("Empty", [], [], { estimatedMinutes: 30 }), epic("G", [bead("t")])], FILTERS, { G: ["Empty"] })
    expect(rowBar(m, "t").start).toBe(NOW + 30 * 60_000)
  })
})

describe("buildGanttModel — cross-epic blockers in the schedule (PR #53)", () => {
  const rowBar = (m: ReturnType<typeof model>, id: string) =>
    m.sections.flatMap((s) => s.rows).find((r) => r.bead.id === id)!.bar!

  test("a planned task starts where a planned blocker in another epic ends", () => {
    const m = model([epic("E1", [bead("a", { estimatedMinutes: 120 })]), epic("E2", [bead("b")])], FILTERS, { b: ["a"] })
    expect(rowBar(m, "a").end).toBe(NOW + 2 * HOUR)
    expect(rowBar(m, "b").start).toBe(NOW + 2 * HOUR)
  })

  test("a planned task starts at now when its blocker in another epic is still running", () => {
    const running = bead("a", { status: "in_progress", startedAt: day(3) })
    const m = model([epic("E1", [running]), epic("E2", [bead("b")])], FILTERS, { b: ["a"] })
    expect(rowBar(m, "a").end).toBe(NOW)
    expect(rowBar(m, "b").start).toBe(NOW)
  })

  test("a finished task without a recorded start starts after its blocker's close and before its own", () => {
    const m = model(
      [
        epic("E1", [bead("a", { status: "closed", closedAt: day(2) })]),
        epic("E2", [bead("b", { status: "closed", closedAt: day(4) })]),
      ],
      FILTERS,
      { b: ["a"] },
    )
    const b = rowBar(m, "b")
    expect(b.start).toBeGreaterThanOrEqual(day(2).getTime())
    expect(b.start).toBeLessThanOrEqual(day(4).getTime())
  })

  test("a recorded start wins over a blocker in another epic", () => {
    const m = model(
      [epic("E1", [bead("a", { estimatedMinutes: 120 })]), epic("E2", [bead("b", { status: "in_progress", startedAt: day(3) })])],
      FILTERS,
      { b: ["a"] },
    )
    expect(rowBar(m, "b").start).toBe(day(3).getTime())
  })
})
