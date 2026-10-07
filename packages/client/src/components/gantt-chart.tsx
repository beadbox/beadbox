// Gantt drawing for the Chart view (beadbox-eic). The model (lib/gantt-model)
// decides what is shown; this component only lays it out: an HTML title
// column (links, focus, truncation) beside one SVG timeline, both in a single
// scroll container so rows stay aligned.

import { ChevronDown, ChevronRight } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { BarStyle, GanttBar, GanttMarker, GanttModel, GanttRow, GanttSection } from "@/lib/gantt-model"
import { routeConnectors } from "@/lib/gantt-routing"
import {
  centeredScrollLeft,
  nowScrollLeft,
  levelScale,
  MAX_LEVEL,
  MIN_LEVEL,
  PRESET_LEVEL,
  paddedDomain,
  presetAt,
  pxPerMs,
  stepFrom,
  tickLabel,
  ticks,
  tickUnit,
  type Zoom,
} from "@/lib/gantt-scale"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

const ROW_H = 28
const AXIS_H = 28
const TITLE_W = 300 // initial and minimum width of the title column
const TITLE_MAX_W = 2 * TITLE_W
const TITLE_KEY_STEP = 16
const BAR_H = 14
const SUMMARY_H = 6
const ZOOMS: Array<[Zoom, string]> = [
  ["fit", "Fit"],
  ["hours", "Hours"],
  ["days", "Days"],
  ["weeks", "Weeks"],
]

const COLLAPSED_KEY = "beadbox:chart-collapsed"
const ZOOM_KEY = "beadbox:chart-zoom"
const TITLE_WIDTH_KEY = "beadbox:chart-title-width"
const CROSS_LINKS_KEY = "beadbox:chart-cross-links"

const clampTitleWidth = (w: number) => Math.min(TITLE_MAX_W, Math.max(TITLE_W, Math.round(w)))

function readTitleWidth(): number {
  const stored = readSession<unknown>(TITLE_WIDTH_KEY, TITLE_W)
  return typeof stored === "number" && Number.isFinite(stored) ? clampTitleWidth(stored) : TITLE_W
}

// Fit, or a level on the zoom ladder (presets are levels 0, 4, 8).
type ZoomState = { kind: "fit" } | { kind: "level"; level: number }

// Reads the session's zoom, including the plain preset names stored before
// the ladder existed; anything unreadable is Fit.
function readZoom(): ZoomState {
  const stored = readSession<unknown>(ZOOM_KEY, "fit")
  if (stored === "hours" || stored === "days" || stored === "weeks") return { kind: "level", level: PRESET_LEVEL[stored] }
  if (
    typeof stored === "object" &&
    stored !== null &&
    (stored as ZoomState).kind === "level" &&
    Number.isInteger((stored as { level: unknown }).level)
  ) {
    const level = (stored as { level: number }).level
    return { kind: "level", level: Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, level)) }
  }
  return { kind: "fit" }
}

// Session-only view state: storage can be missing or throw (private window,
// tests), and the chart must work without it.
function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

// Stored garbage must not blank the chart: keep only the string ids.
function readCollapsed(): string[] {
  const stored = readSession<unknown>(COLLAPSED_KEY, [])
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []
}

function writeSession(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable: state lasts until unmount
  }
}

const MARKER_HIT_R = 8
const PLANNED_DASH = "4 3"
// A bar placed without a start time from bd: dotted and faded (beadbox-8wz).
const INFERRED_DASH = "1 2"
const INFERRED_OPACITY = 0.5
const NOW_DASH = "2 3"
const NOW_CLASS = "stroke-foreground/40"
const CONNECTOR_CLASS = "stroke-muted-foreground"
const MARKER_CLASS: Record<GanttMarker["relation"], string> = {
  "blocked-by": "fill-amber-500",
  blocks: "fill-muted-foreground",
}

const BAR_CLASS: Record<BarStyle, string> = {
  waiting: "fill-transparent stroke-muted-foreground",
  blocked: "fill-transparent stroke-red-500",
  working: "fill-blue-500 stroke-blue-500",
  done: "fill-emerald-500/70 stroke-emerald-500/70",
}

type Line =
  | { kind: "section"; section: GanttSection; collapsed: boolean }
  | { kind: "row"; row: GanttRow; indent: number }

function flatten(sections: GanttSection[], collapsed: Set<string>, out: Line[] = []): Line[] {
  for (const section of sections) {
    const isCollapsed = collapsed.has(section.id)
    out.push({ kind: "section", section, collapsed: isCollapsed })
    if (isCollapsed) continue
    for (const row of section.rows) out.push({ kind: "row", row, indent: section.depth + 1 + row.depth })
    flatten(section.sections, collapsed, out)
  }
  return out
}

// For each bead, the ids of the sections containing it, outermost first, so a
// link into a collapsed epic can be redirected to that epic's header (design D2).
function sectionStructure(sections: GanttSection[]): { chainOf: (beadId: string) => string[] } {
  const chains = new Map<string, string[]>()
  const walk = (list: GanttSection[], outer: string[]) => {
    for (const section of list) {
      const chain = [...outer, section.id]
      for (const row of section.rows) if (!chains.has(row.bead.id)) chains.set(row.bead.id, chain)
      walk(section.sections, chain)
    }
  }
  walk(sections, [])
  return { chainOf: (beadId) => chains.get(beadId) ?? [] }
}

function markerText(m: GanttMarker): string {
  return `${m.relation === "blocked-by" ? "Blocked by" : "Blocks"} ${m.otherId}: ${m.otherTitle}`
}

interface GanttChartProps {
  model: GanttModel
  now: number // separates what happened (left) from the plan (right)
  onOpenBead: (id: string) => void
}

export function GanttChart({ model, now, onOpenBead }: GanttChartProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readCollapsed()))
  const [zoom, setZoom] = useState<ZoomState>(readZoom)
  const scrollRef = useRef<HTMLDivElement>(null)
  const titlesRef = useRef<HTMLDivElement>(null)
  const [titleW, setTitleWState] = useState(readTitleWidth)
  const [crossLinks, setCrossLinksState] = useState(() => readSession<unknown>(CROSS_LINKS_KEY, false) === true)
  const toggleCrossLinks = () => {
    setCrossLinksState((on) => {
      writeSession(CROSS_LINKS_KEY, !on)
      return !on
    })
  }
  const setTitleW = (w: number) => {
    const next = clampTitleWidth(w)
    setTitleWState(next)
    writeSession(TITLE_WIDTH_KEY, next)
  }
  const resizeDrag = useRef<{ startX: number; startW: number } | null>(null)
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    resizeDrag.current = { startX: e.clientX, startW: titleW }
  }
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current
    if (drag) setTitleW(drag.startW + e.clientX - drag.startX)
  }
  const onResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    resizeDrag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }
  const onResizeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    setTitleW(titleW + (e.key === "ArrowRight" ? TITLE_KEY_STEP : -TITLE_KEY_STEP))
  }
  const [viewWidth, setViewWidth] = useState(800)
  const [scrollbarH, setScrollbarH] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      setViewWidth(Math.max(el.clientWidth, 200))
      setScrollbarH(el.offsetHeight - el.clientHeight)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The title pane mirrors the scroller's vertical position, in the same
  // scroll event so the titles never lag their bars. Copying only when the
  // values differ keeps the two handlers from echoing each other.
  const onScrollerScroll = () => {
    const [scroller, titles] = [scrollRef.current, titlesRef.current]
    if (scroller && titles && titles.scrollTop !== scroller.scrollTop) titles.scrollTop = scroller.scrollTop
  }
  // Keyboard focus moving to an off-screen title scrolls the title pane.
  const onTitlesScroll = () => {
    const [scroller, titles] = [scrollRef.current, titlesRef.current]
    if (scroller && titles && scroller.scrollTop !== titles.scrollTop) scroller.scrollTop = titles.scrollTop
  }
  // The title pane cannot scroll by wheel itself; hand the wheel to the scroller.
  const onTitlesWheel = (e: React.WheelEvent) => {
    const lineHeight = e.deltaMode === 1 ? ROW_H : 1
    scrollRef.current?.scrollBy({ left: e.deltaX * lineHeight, top: e.deltaY * lineHeight })
  }

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeSession(COLLAPSED_KEY, [...next])
      return next
    })
  }

  const applyZoom = (next: ZoomState) => {
    setZoom(next)
    writeSession(ZOOM_KEY, next)
  }

  const lines = useMemo(() => flatten(model.sections, collapsed), [model.sections, collapsed])
  const structure = useMemo(() => sectionStructure(model.sections), [model.sections])

  // Every zoom change but Fit lands with now at 75% of the view (PR #53);
  // when now is not on the timeline, +/- keep the centre instead.
  // The anchor is taken before the zoom changes and applied before paint.
  const geometry = useRef({ domainStart: 0, scale: 1, contentW: 0 })
  const pendingAnchor = useRef<{ kind: "now" | "centre"; t: number } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per zoom change; geometry is read from the ref
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const anchor = pendingAnchor.current
    if (!scroller || anchor === null) return
    pendingAnchor.current = null
    const { domainStart, scale, contentW } = geometry.current
    const place = anchor.kind === "now" ? nowScrollLeft : centeredScrollLeft
    scroller.scrollLeft = place(anchor.t, domainStart, scale, scroller.clientWidth, contentW)
  }, [zoom])

  if (!model.extent) {
    return <p className="text-sm text-muted-foreground px-1 py-8">No beads match the current filters.</p>
  }

  const domain = paddedDomain(model.extent)
  const scale = zoom.kind === "fit" ? pxPerMs("fit", domain, viewWidth) : levelScale(zoom.level)
  const activeZoom: Zoom | null = zoom.kind === "fit" ? "fit" : presetAt(zoom.level)
  // From Fit the next step is the nearest level past Fit's scale; otherwise one level.
  const stepTo = (direction: 1 | -1) =>
    zoom.kind === "fit" ? stepFrom(scale, direction) : Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, zoom.level + direction))
  const canZoomIn = zoom.kind === "fit" ? scale < levelScale(MAX_LEVEL) : zoom.level < MAX_LEVEL
  const canZoomOut = zoom.kind === "fit" ? scale > levelScale(MIN_LEVEL) : zoom.level > MIN_LEVEL
  geometry.current = { domainStart: domain.start, scale, contentW: Math.max((domain.end - domain.start) * scale, viewWidth) }
  const nowOnTimeline = now >= domain.start && now <= domain.end
  const zoomBy = (direction: 1 | -1) => {
    const scroller = scrollRef.current
    if (nowOnTimeline) pendingAnchor.current = { kind: "now", t: now }
    else if (scroller) {
      pendingAnchor.current = { kind: "centre", t: domain.start + (scroller.scrollLeft + scroller.clientWidth / 2) / scale }
    }
    applyZoom({ kind: "level", level: stepTo(direction) })
  }
  const chooseZoom = (z: Zoom) => {
    if (z === "fit") return applyZoom({ kind: "fit" })
    if (nowOnTimeline) pendingAnchor.current = { kind: "now", t: now }
    applyZoom({ kind: "level", level: PRESET_LEVEL[z] })
  }
  const unit = tickUnit(scale)
  const x = (t: number) => (t - domain.start) * scale
  const timelineW = Math.max(x(domain.end), viewWidth)
  const height = lines.length * ROW_H

  const midY = (i: number) => i * ROW_H + ROW_H / 2
  // Drawn horizontal extent of each line's bar: the obstacles connectors route around.
  const drawn = (bar: GanttBar, minWidth: number): [number, number] => [
    x(bar.start),
    x(bar.start) + Math.max(x(bar.end) - x(bar.start), minWidth),
  ]
  const rowIndex = new Map<string, number>()
  const headerIndex = new Map<string, number>()
  const obstacles = lines.map((line, i): [number, number] | null => {
    if (line.kind === "section") {
      headerIndex.set(line.section.id, i)
      const bar = line.section.bar
      return bar ? drawn(bar, line.section.barKind === "own" ? 3 : 2) : null
    }
    rowIndex.set(line.row.bead.id, i)
    return line.row.bar ? drawn(line.row.bar, 3) : null
  })
  // A bead's line: its own row, or, when it is inside a collapsed epic, the
  // header of the outermost collapsed epic containing it (design D2).
  const anchorOf = (beadId: string): { line: number; id: string } | undefined => {
    const row = rowIndex.get(beadId)
    if (row !== undefined) return { line: row, id: beadId }
    const chain = structure.chainOf(beadId) // outermost first
    const folded = chain.find((sectionId) => collapsed.has(sectionId))
    const header = folded === undefined ? undefined : headerIndex.get(folded)
    return header === undefined || folded === undefined ? undefined : { line: header, id: folded }
  }
  const links: Array<{ fromLine: number; toLine: number; from: string; to: string; cross: boolean }> = []
  const linked = new Set<string>()
  for (const { from, to } of model.edges) {
    const [a, b] = [rowIndex.get(from), rowIndex.get(to)]
    if (a === undefined || b === undefined || !obstacles[a] || !obstacles[b]) continue
    links.push({ fromLine: a, toLine: b, from, to, cross: false })
    linked.add(`${a}->${b}`)
  }
  const drawnCrossEdges = new Set<string>()
  if (crossLinks) {
    for (const { from, to } of model.crossEdges) {
      const [a, b] = [anchorOf(from), anchorOf(to)]
      if (!a || !b || a.line === b.line || !obstacles[a.line] || !obstacles[b.line]) continue
      drawnCrossEdges.add(`${from}->${to}`)
      const key = `${a.line}->${b.line}`
      if (linked.has(key)) continue
      linked.add(key)
      links.push({ fromLine: a.line, toLine: b.line, from: a.id, to: b.id, cross: true })
    }
  }
  const connectors = routeConnectors(
    links.map(({ fromLine, toLine }) => ({ fromRow: fromLine, toRow: toLine })),
    { rowHeight: ROW_H, bars: obstacles },
  )
  // While links across epics are drawn, their dots would say the same thing twice.
  const markerShown = (beadId: string, m: GanttMarker) =>
    !drawnCrossEdges.has(m.relation === "blocked-by" ? `${m.otherId}->${beadId}` : `${beadId}->${m.otherId}`)

  return (
    <div className="flex flex-col min-h-0 min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-1 mb-2" role="group" aria-label="Zoom">
        {ZOOMS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => chooseZoom(value)}
            aria-pressed={activeZoom === value}
            className={cn(
              "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
              activeZoom === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
          >
            {label}
          </button>
        ))}
        {(
          [
            [1, "+", "Zoom in", canZoomIn],
            [-1, "\u2212", "Zoom out", canZoomOut],
          ] as const
        ).map(([direction, label, name, enabled]) => (
          <button
            key={name}
            type="button"
            onClick={() => zoomBy(direction)}
            disabled={!enabled}
            aria-label={name}
            title={name}
            className="ml-0.5 h-6 w-6 rounded-md text-sm font-medium leading-none text-muted-foreground transition-colors hover:text-foreground hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-40"
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={toggleCrossLinks}
          aria-pressed={crossLinks}
          title="Draw dependencies between beads in different epics as arrows"
          className={cn(
            "ml-2 px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
            crossLinks ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
          )}
        >
          Links across epics
        </button>
        <Legend />
      </div>

      {/* Two columns. The timeline scroller on the right is the only scroll
          container, so its scrollbars run only along the bars; the title pane
          on the left has no scrollbar and follows it vertically (design D1). */}
      <div className="relative flex flex-1 min-h-0 min-w-0 rounded-md border border-border/50" data-testid="gantt-frame">
        <div className="relative flex shrink-0 flex-col bg-background border-r border-border/50" style={{ width: titleW }}>
          {/* Drag (or ←/→) to widen the titles, from 300 up to 600 px (design D4). */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize bead titles"
            aria-valuemin={TITLE_W}
            aria-valuemax={TITLE_MAX_W}
            aria-valuenow={titleW}
            tabIndex={0}
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            onKeyDown={onResizeKey}
            className="absolute top-0 -right-1 z-30 h-full w-2 cursor-col-resize outline-none hover:bg-border/60 focus-visible:bg-border"
            data-testid="gantt-title-resize"
          />
          <div className="shrink-0 border-b border-border/50" style={{ height: AXIS_H }} data-testid="gantt-corner" />
          <div
            ref={titlesRef}
            className="flex-1 min-h-0 overflow-hidden"
            onScroll={onTitlesScroll}
            onWheel={onTitlesWheel}
            data-testid="gantt-titles"
          >
            {lines.map((line) =>
              line.kind === "section" ? (
                <button
                  key={`s:${line.section.id}`}
                  type="button"
                  onClick={() => toggle(line.section.id)}
                  aria-expanded={!line.collapsed}
                  className="flex w-full items-center gap-1 text-left text-sm font-semibold hover:bg-accent/50"
                  style={{ height: ROW_H, paddingLeft: 4 + line.section.depth * 16 }}
                  data-testid="gantt-section"
                >
                  {line.collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate">{line.section.title}</span>
                </button>
              ) : (
                <button
                  key={`r:${line.row.bead.id}`}
                  type="button"
                  onClick={() => onOpenBead(line.row.bead.id)}
                  title={`${line.row.bead.id}: ${line.row.bead.title}`}
                  className="flex w-full items-center gap-2 text-left text-sm hover:bg-accent/50 hover:underline"
                  style={{ height: ROW_H, paddingLeft: 8 + line.indent * 16 }}
                  data-testid="gantt-row-title"
                >
                  <span className="font-mono text-[10px] text-muted-foreground shrink-0">{line.row.bead.id}</span>
                  <span className="truncate">{line.row.bead.title}</span>
                </button>
              ),
            )}
            {/* Room for the scroller's horizontal scrollbar, so the last row lines up. */}
            <div style={{ height: scrollbarH }} aria-hidden="true" />
          </div>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 min-h-0 min-w-0 overflow-auto"
          onScroll={onScrollerScroll}
          data-testid="gantt-scroll"
        >
          <div style={{ width: timelineW }} data-testid="gantt-content">
            <div className="sticky top-0 z-20" data-testid="gantt-header-row">
              <svg className="block bg-background border-b border-border/50" width={timelineW} height={AXIS_H} aria-hidden="true">
                {ticks(domain, unit).map((t) => (
                  <g key={t} transform={`translate(${x(t)},0)`}>
                    <line y1={AXIS_H - 6} y2={AXIS_H} className="stroke-border" />
                    <text x={4} y={AXIS_H - 10} className="fill-muted-foreground text-[10px]">
                      {tickLabel(t, unit)}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          <svg className="block" width={timelineW} height={height} data-testid="gantt-timeline">
            <defs>
              {/* Tip (x=6) sits exactly on the dependent's start edge. */}
              <marker id="gantt-arrow" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L6,3 L0,6 z" className="fill-muted-foreground" />
              </marker>
              <marker id="gantt-arrow-strong" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L6,3 L0,6 z" className="fill-foreground" />
              </marker>
            </defs>
            {ticks(domain, unit).map((t) => (
              <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={height} className="stroke-border/40" />
            ))}
            {now >= domain.start && now <= domain.end && (
              <line x1={x(now)} x2={x(now)} y1={0} y2={height} strokeDasharray={NOW_DASH} className={NOW_CLASS} data-testid="gantt-now" />
            )}
            {lines.map((line, i) => {
              if (line.kind === "section") {
                const bar = line.section.bar
                if (!bar) return null
                if (line.section.barKind === "own") {
                  return <BarRect key={`s:${line.section.id}`} bar={bar} x={x} y={midY(i)} testId="gantt-own-bar" />
                }
                return (
                  <rect
                    key={`s:${line.section.id}`}
                    x={x(bar.start)}
                    y={midY(i) - SUMMARY_H / 2}
                    width={Math.max(x(bar.end) - x(bar.start), 2)}
                    height={SUMMARY_H}
                    rx={2}
                    className="fill-foreground/60"
                    data-testid="gantt-summary-bar"
                  />
                )
              }
              const { bar, bead } = line.row
              if (!bar) return null
              return (
                <g key={`r:${bead.id}`}>
                  <BarRect bar={bar} x={x} y={midY(i)} testId="gantt-bar" beadId={bead.id} onClick={() => onOpenBead(bead.id)} />
                  {/* The app's tooltip, not an SVG <title>: the desktop webview does not show native ones. */}
                  {(model.markers[bead.id] ?? []).filter((m) => markerShown(bead.id, m)).map((m, k) => (
                    <Tooltip key={`${m.relation}:${m.otherId}`}>
                      <TooltipTrigger asChild>
                        <g
                          tabIndex={0}
                          aria-label={markerText(m)}
                          className="cursor-default outline-none focus-visible:[&>circle:last-child]:stroke-foreground"
                          data-testid="gantt-marker"
                        >
                          {/* Larger invisible hit area around the visible dot. */}
                          <circle cx={x(bar.end) + 8 + k * 9} cy={midY(i)} r={MARKER_HIT_R} fill="transparent" />
                          <circle
                            cx={x(bar.end) + 8 + k * 9}
                            cy={midY(i)}
                            r={3.5}
                            className={MARKER_CLASS[m.relation]}
                          />
                        </g>
                      </TooltipTrigger>
                      <TooltipContent>{markerText(m)}</TooltipContent>
                    </Tooltip>
                  ))}
                </g>
              )
            })}
            {links.map(({ from, to, toLine, cross }, k) => {
              const points = connectors[k]
              if (points.length < 2) return null
              const target = lines[toLine]
              const hollow =
                target.kind === "row" && (target.row.bar?.style === "waiting" || target.row.bar?.style === "blocked")
              return (
                <path
                  key={`${from}->${to}`}
                  d={points.map(([px, py], n) => `${n === 0 ? "M" : "L"}${px},${py}`).join(" ")}
                  fill="none"
                  className={hollow ? "stroke-foreground" : CONNECTOR_CLASS}
                  markerEnd={hollow ? "url(#gantt-arrow-strong)" : "url(#gantt-arrow)"}
                  data-testid="gantt-arrow"
                  data-from={from}
                  data-to={to}
                  data-cross={cross ? "true" : undefined}
                />
              )
            })}
          </svg>
          </div>
        </div>
      </div>
    </div>
  )
}

function BarRect({
  bar,
  x,
  y,
  testId,
  beadId,
  onClick,
}: {
  bar: GanttBar
  x: (t: number) => number
  y: number
  testId: string
  beadId?: string
  // Bead rows only: a pointer shortcut for the title button (design D3).
  onClick?: () => void
}) {
  const hollow = bar.style === "waiting" || bar.style === "blocked"
  return (
    <rect
      x={x(bar.start)}
      y={y - BAR_H / 2}
      width={Math.max(x(bar.end) - x(bar.start), 3)}
      height={BAR_H}
      rx={3}
      strokeWidth={1.5}
      strokeDasharray={bar.style === "waiting" ? PLANNED_DASH : bar.inferred ? INFERRED_DASH : undefined}
      fillOpacity={bar.inferred ? INFERRED_OPACITY : undefined}
      className={BAR_CLASS[bar.style]}
      data-style={`${hollow ? `${bar.style} hollow` : bar.style}${bar.inferred ? " inferred" : ""}`}
      data-testid={testId}
      data-bead-id={beadId}
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
    />
  )
}

// Drawn with the chart's own style constants so it always matches the chart.
const LEGEND: Array<{ key: string; label: string; swatch: React.ReactNode }> = [
  { key: "working", label: "Working", swatch: <rect x={1} y={2} width={20} height={8} rx={2} strokeWidth={1.5} className={BAR_CLASS.working} /> },
  {
    key: "planned",
    label: "Planned / not started",
    swatch: <rect x={1} y={2} width={20} height={8} rx={2} strokeWidth={1.5} strokeDasharray={PLANNED_DASH} className={BAR_CLASS.waiting} />,
  },
  { key: "blocked", label: "Blocked", swatch: <rect x={1} y={2} width={20} height={8} rx={2} strokeWidth={1.5} className={BAR_CLASS.blocked} /> },
  { key: "done", label: "Done", swatch: <rect x={1} y={2} width={20} height={8} rx={2} strokeWidth={1.5} className={BAR_CLASS.done} /> },
  {
    key: "inferred",
    label: "Start not recorded (placed after blockers)",
    swatch: (
      <rect
        x={1}
        y={2}
        width={20}
        height={8}
        rx={2}
        strokeWidth={1.5}
        strokeDasharray={INFERRED_DASH}
        fillOpacity={INFERRED_OPACITY}
        className={BAR_CLASS.working}
      />
    ),
  },
  {
    key: "connector",
    label: "Blocks",
    swatch: (
      <>
        <line x1={1} y1={6} x2={17} y2={6} className={CONNECTOR_CLASS} />
        <path d="M16,3 L21,6 L16,9 z" className="fill-muted-foreground" />
      </>
    ),
  },
  { key: "blocked-by", label: "Blocked by a bead in another epic", swatch: <circle cx={11} cy={6} r={3.5} className={MARKER_CLASS["blocked-by"]} /> },
  { key: "blocks", label: "Blocks a bead in another epic", swatch: <circle cx={11} cy={6} r={3.5} className={MARKER_CLASS.blocks} /> },
  { key: "now", label: "Now", swatch: <line x1={11} y1={0} x2={11} y2={12} strokeDasharray={NOW_DASH} className={NOW_CLASS} /> },
]

function Legend() {
  return (
    <ul className="ml-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label="Legend" data-testid="gantt-legend">
      {LEGEND.map(({ key, label, swatch }) => (
        <li key={key} className="inline-flex items-center gap-1" data-testid={`legend-${key}`}>
          <svg width={22} height={12} aria-hidden="true">
            {swatch}
          </svg>
          {label}
        </li>
      ))}
    </ul>
  )
}
