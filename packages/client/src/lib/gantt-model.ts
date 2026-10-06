// Chart view model (beadbox-eic): turns the epic tree into Gantt sections,
// rows, bars and dependency edges. Pure, so the SVG components only draw.

import { filterEpics, isArchived, withoutArchived } from "./epic-tree-utils"
import type { Bead, Epic, Filters } from "./types"

export const STARTED_AT_KEY = "started_at"
export const UNGROUPED_ID = "_standalone"

// waiting = not started (open/deferred), blocked, working = any other
// non-closed status, done = closed.
export type BarStyle = "waiting" | "blocked" | "working" | "done"

export interface GanttBar {
  start: number // epoch ms
  end: number // epoch ms
  style: BarStyle
}

export interface GanttRow {
  bead: Bead
  sectionId: string
  depth: number // subtask nesting inside the section
  bar: GanttBar | null
}

export interface GanttSection {
  id: string
  title: string
  epic: Epic | null // null for Ungrouped
  depth: number
  rows: GanttRow[]
  sections: GanttSection[]
  // Summary bar over everything inside, or the epic's own bar when nothing is.
  bar: GanttBar | null
  barKind: "summary" | "own"
}

export interface GanttEdge {
  from: string // blocker bead id
  to: string // blocked bead id
}

export interface GanttMarker {
  otherId: string
  otherTitle: string
  relation: "blocked-by" | "blocks"
}

export interface GanttModel {
  sections: GanttSection[]
  edges: GanttEdge[]
  markers: Record<string, GanttMarker[]>
  extent: { start: number; end: number } | null
  dependenciesDegraded: boolean
}

export function barStyle(status: string): BarStyle {
  if (status === "closed") return "done"
  if (status === "blocked") return "blocked"
  if (status === "open" || status === "deferred") return "waiting"
  return "working"
}

const NOT_STARTED = new Set(["open", "deferred", "blocked"])
const DEFAULT_PLANNED_MS = 60 * 60_000

// One bead's bar given the latest finish among its blockers (design D12).
// A recorded start is what happened and wins over the plan; without one, a
// bead is placed after its blockers; a not-started bead is drawn as its
// planned window from now on.
function scheduledBar(bead: Bead, latest: number, now: number): GanttBar | null {
  const style = barStyle(bead.status)
  const recorded = Date.parse(bead.metadata?.[STARTED_AT_KEY] ?? "")
  const created = bead.createdAt?.getTime()
  const closedAt = bead.closedAt?.getTime() ?? bead.updatedAt?.getTime() ?? now
  let start: number
  let end: number
  if (!Number.isNaN(recorded)) {
    start = recorded
    end = style === "done" ? closedAt : now
  } else if (NOT_STARTED.has(bead.status)) {
    start = Math.max(now, latest)
    end = start + (bead.estimatedMinutes ? bead.estimatedMinutes * 60_000 : DEFAULT_PLANNED_MS)
  } else {
    const earliest = Math.max(created ?? Number.NEGATIVE_INFINITY, latest)
    if (!Number.isFinite(earliest)) return null
    end = style === "done" ? closedAt : now
    start = Math.min(end, earliest)
  }
  return { start, end: Math.max(start, end), style }
}

interface BeadIndex {
  beads: Map<string, Bead>
  ancestorEpics: Map<string, string[]> // nearest first
  descendants: Map<string, string[]> // for epics: every bead and epic inside
}

function indexBeads(epics: Epic[]): BeadIndex {
  const index: BeadIndex = { beads: new Map(), ancestorEpics: new Map(), descendants: new Map() }
  const visit = (bead: Bead, ancestors: string[]) => {
    const real = bead.id !== UNGROUPED_ID
    if (real && !index.beads.has(bead.id)) {
      index.beads.set(bead.id, bead)
      index.ancestorEpics.set(bead.id, ancestors)
      for (const a of ancestors) index.descendants.get(a)?.push(bead.id)
    }
    const isEpic = real && "childEpics" in bead
    if (isEpic && !index.descendants.has(bead.id)) index.descendants.set(bead.id, [])
    const inner = isEpic ? [bead.id, ...ancestors] : ancestors
    for (const child of bead.children ?? []) visit(child, inner)
    for (const child of (bead as Epic).childEpics ?? []) visit(child, inner)
  }
  for (const epic of epics) visit(epic, [])
  return index
}

// Bars for every loaded bead, each placed after its blockers' bars. A bead
// also waits for the blockers of its ancestor epics (design D6 of
// improve-chart-scroll-and-zoom), and an epic used as a blocker finishes when
// the last bar inside it ends. Runs on the unfiltered tree so blockers hidden
// by filters still count. A bead or epic met again while it is being computed
// (a cycle) adds no constraint; null blockedBy (dependency data unavailable)
// schedules nothing after anything.
export function scheduleBars(
  epics: Epic[],
  blockedBy: Record<string, string[]> | null,
  now: number,
): Map<string, GanttBar | null> {
  const { beads, ancestorEpics, descendants } = indexBeads(epics)
  const bars = new Map<string, GanttBar | null>()
  const inProgress = new Set<string>()
  const finishing = new Set<string>()

  const finishOf = (id: string): number => {
    const inside = descendants.get(id)
    if (!inside?.length || finishing.has(id)) return barOf(id)?.end ?? Number.NEGATIVE_INFINITY
    finishing.add(id)
    let end = Number.NEGATIVE_INFINITY
    for (const d of inside) {
      if (inProgress.has(d)) continue
      const bar = barOf(d)
      if (bar) end = Math.max(end, bar.end)
    }
    finishing.delete(id)
    return Number.isFinite(end) ? end : (barOf(id)?.end ?? Number.NEGATIVE_INFINITY)
  }

  function barOf(id: string): GanttBar | null {
    if (bars.has(id)) return bars.get(id)!
    if (inProgress.has(id)) return null
    const bead = beads.get(id)!
    inProgress.add(id)
    let latest = Number.NEGATIVE_INFINITY
    for (const owner of [id, ...(ancestorEpics.get(id) ?? [])]) {
      for (const blocker of blockedBy?.[owner] ?? []) {
        if (!beads.has(blocker) || inProgress.has(blocker)) continue
        latest = Math.max(latest, finishOf(blocker))
      }
    }
    inProgress.delete(id)
    const bar = scheduledBar(bead, latest, now)
    bars.set(id, bar)
    return bar
  }

  for (const id of beads.keys()) barOf(id)
  return bars
}

function span(bars: Array<GanttBar | null>): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const bar of bars) {
    if (!bar) continue
    start = Math.min(start, bar.start)
    end = Math.max(end, bar.end)
  }
  return start <= end ? { start, end } : null
}

type Bars = Map<string, GanttBar | null>

function buildRows(beads: Bead[], sectionId: string, depth: number, bars: Bars, out: GanttRow[]): void {
  for (const bead of beads) {
    out.push({ bead, sectionId, depth, bar: bars.get(bead.id) ?? null })
    if (bead.children?.length) buildRows(bead.children, sectionId, depth + 1, bars, out)
  }
}

function buildSection(epic: Epic, depth: number, bars: Bars): GanttSection {
  const isUngrouped = epic.id === UNGROUPED_ID
  const rows: GanttRow[] = []
  buildRows(epic.children ?? [], epic.id, 0, bars, rows)
  const sections = (epic.childEpics ?? []).map((child) => buildSection(child, depth + 1, bars))
  const inside = span([...rows.map((r) => r.bar), ...sections.map((s) => s.bar)])
  const hasContent = rows.length > 0 || sections.length > 0
  const own = isUngrouped ? null : (bars.get(epic.id) ?? null)
  return {
    id: epic.id,
    title: isUngrouped ? "Ungrouped" : epic.title,
    epic: isUngrouped ? null : epic,
    depth,
    rows,
    sections,
    bar: hasContent ? (inside ? { ...inside, style: "working" } : null) : own,
    barKind: hasContent ? "summary" : "own",
  }
}

function collectRows(section: GanttSection, out: GanttRow[]): void {
  out.push(...section.rows)
  for (const child of section.sections) collectRows(child, out)
}

function indexTitles(beads: Bead[], titles: Map<string, string>): void {
  for (const bead of beads) {
    titles.set(bead.id, bead.title)
    if (bead.children) indexTitles(bead.children, titles)
    if ((bead as Epic).childEpics) indexTitles((bead as Epic).childEpics!, titles)
  }
}

// blockedBy maps a bead id to the ids blocking it; null means the dependency
// data could not be loaded, which is not the same as "nothing is blocked".
function buildDependencies(
  rows: GanttRow[],
  blockedBy: Record<string, string[]> | null,
  titles: Map<string, string>,
): { edges: GanttEdge[]; markers: Record<string, GanttMarker[]> } {
  const edges: GanttEdge[] = []
  const markers: Record<string, GanttMarker[]> = {}
  if (!blockedBy) return { edges, markers }
  const sectionOf = new Map(rows.map((row) => [row.bead.id, row.sectionId]))
  const mark = (id: string, marker: GanttMarker) => {
    if (!markers[id]) markers[id] = []
    markers[id].push(marker)
  }
  for (const row of rows) {
    const blocked = row.bead.id
    for (const blocker of blockedBy[blocked] ?? []) {
      const blockerSection = sectionOf.get(blocker)
      if (blockerSection === row.sectionId) {
        edges.push({ from: blocker, to: blocked })
        continue
      }
      mark(blocked, { otherId: blocker, otherTitle: titles.get(blocker) ?? blocker, relation: "blocked-by" })
      if (blockerSection !== undefined) {
        mark(blocker, { otherId: blocked, otherTitle: titles.get(blocked) ?? blocked, relation: "blocks" })
      }
    }
  }
  return { edges, markers }
}

export function buildGanttModel(
  epics: Epic[],
  blockedBy: Record<string, string[]> | null,
  filters: Filters,
  now: number,
  rigNames: string[] = [],
): GanttModel {
  const titles = new Map<string, string>()
  indexTitles(epics, titles)
  const live = epics.filter((epic) => !isArchived(epic)).map(withoutArchived)
  const bars = scheduleBars(live, blockedBy, now)
  const visible = filterEpics(live, filters, rigNames)
  // Ungrouped goes last, as in the epic tree.
  visible.sort((a, b) => Number(a.id === UNGROUPED_ID) - Number(b.id === UNGROUPED_ID))
  const sections = visible.map((epic) => buildSection(epic, 0, bars))
  const rows: GanttRow[] = []
  for (const section of sections) collectRows(section, rows)
  const { edges, markers } = buildDependencies(rows, blockedBy, titles)
  return {
    sections,
    edges,
    markers,
    extent: span(sections.map((s) => s.bar)),
    dependenciesDegraded: blockedBy === null,
  }
}
