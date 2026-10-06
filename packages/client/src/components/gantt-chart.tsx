// Gantt drawing for the Chart view (beadbox-eic). The model (lib/gantt-model)
// decides what is shown; this component only lays it out: an HTML title
// column (links, focus, truncation) beside one SVG timeline, both in a single
// scroll container so rows stay aligned.

import { ChevronDown, ChevronRight } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { BarStyle, GanttBar, GanttMarker, GanttModel, GanttRow, GanttSection } from "@/lib/gantt-model"
import { routeConnectors } from "@/lib/gantt-routing"
import { paddedDomain, pxPerMs, tickLabel, ticks, tickUnit, type Zoom } from "@/lib/gantt-scale"
import { cn } from "@/lib/utils"

const ROW_H = 28
const AXIS_H = 28
const TITLE_W = 300
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

function writeSession(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable: state lasts until unmount
  }
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

function markerText(m: GanttMarker): string {
  return `${m.relation === "blocked-by" ? "Blocked by" : "Blocks"} ${m.otherId}: ${m.otherTitle}`
}

interface GanttChartProps {
  model: GanttModel
  now: number // separates what happened (left) from the plan (right)
  onOpenBead: (id: string) => void
}

export function GanttChart({ model, now, onOpenBead }: GanttChartProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readSession<string[]>(COLLAPSED_KEY, [])))
  const [zoom, setZoom] = useState<Zoom>(() => readSession<Zoom>(ZOOM_KEY, "fit"))
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewWidth, setViewWidth] = useState(800)

  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setViewWidth(Math.max(el.clientWidth - TITLE_W, 200)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeSession(COLLAPSED_KEY, [...next])
      return next
    })
  }

  const chooseZoom = (z: Zoom) => {
    setZoom(z)
    writeSession(ZOOM_KEY, z)
  }

  const lines = useMemo(() => flatten(model.sections, collapsed), [model.sections, collapsed])

  if (!model.extent) {
    return <p className="text-sm text-muted-foreground px-1 py-8">No beads match the current filters.</p>
  }

  const domain = paddedDomain(model.extent)
  const scale = pxPerMs(zoom, domain, viewWidth)
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
  const obstacles = lines.map((line, i): [number, number] | null => {
    if (line.kind === "section") {
      const bar = line.section.bar
      return bar ? drawn(bar, line.section.barKind === "own" ? 3 : 2) : null
    }
    rowIndex.set(line.row.bead.id, i)
    return line.row.bar ? drawn(line.row.bar, 3) : null
  })
  const shownEdges = model.edges.filter(
    ({ from, to }) => obstacles[rowIndex.get(from) ?? -1] && obstacles[rowIndex.get(to) ?? -1],
  )
  const connectors = routeConnectors(
    shownEdges.map(({ from, to }) => ({ fromRow: rowIndex.get(from)!, toRow: rowIndex.get(to)! })),
    { rowHeight: ROW_H, bars: obstacles },
  )

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-1 mb-2" role="group" aria-label="Zoom">
        {ZOOMS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => chooseZoom(value)}
            aria-pressed={zoom === value}
            className={cn(
              "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
              zoom === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-auto rounded-md border border-border/50" data-testid="gantt-scroll">
        <div className="grid" style={{ gridTemplateColumns: `${TITLE_W}px ${timelineW}px` }}>
          {/* Corner + axis */}
          <div className="sticky top-0 left-0 z-30 bg-background border-b border-r border-border/50" style={{ height: AXIS_H }} />
          <svg className="sticky top-0 z-20 bg-background border-b border-border/50" width={timelineW} height={AXIS_H} aria-hidden="true">
            {ticks(domain, unit).map((t) => (
              <g key={t} transform={`translate(${x(t)},0)`}>
                <line y1={AXIS_H - 6} y2={AXIS_H} className="stroke-border" />
                <text x={4} y={AXIS_H - 10} className="fill-muted-foreground text-[10px]">
                  {tickLabel(t, unit)}
                </text>
              </g>
            ))}
          </svg>

          {/* Title column */}
          <div className="sticky left-0 z-10 bg-background border-r border-border/50">
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
          </div>

          {/* Timeline */}
          <svg width={timelineW} height={height} data-testid="gantt-timeline">
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
              <line x1={x(now)} x2={x(now)} y1={0} y2={height} strokeDasharray="2 3" className="stroke-foreground/40" data-testid="gantt-now" />
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
                  <BarRect bar={bar} x={x} y={midY(i)} testId="gantt-bar" beadId={bead.id} />
                  {(model.markers[bead.id] ?? []).map((m, k) => (
                    <circle
                      key={`${m.relation}:${m.otherId}`}
                      cx={x(bar.end) + 8 + k * 9}
                      cy={midY(i)}
                      r={3.5}
                      className={m.relation === "blocked-by" ? "fill-amber-500" : "fill-muted-foreground"}
                      aria-label={markerText(m)}
                      data-testid="gantt-marker"
                    >
                      <title>{markerText(m)}</title>
                    </circle>
                  ))}
                </g>
              )
            })}
            {shownEdges.map(({ from, to }, k) => {
              const points = connectors[k]
              if (points.length < 2) return null
              const target = lines[rowIndex.get(to)!]
              const hollow =
                target.kind === "row" && (target.row.bar?.style === "waiting" || target.row.bar?.style === "blocked")
              return (
                <path
                  key={`${from}->${to}`}
                  d={points.map(([px, py], n) => `${n === 0 ? "M" : "L"}${px},${py}`).join(" ")}
                  fill="none"
                  className={hollow ? "stroke-foreground" : "stroke-muted-foreground"}
                  markerEnd={hollow ? "url(#gantt-arrow-strong)" : "url(#gantt-arrow)"}
                  data-testid="gantt-arrow"
                  data-from={from}
                  data-to={to}
                />
              )
            })}
          </svg>
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
}: {
  bar: GanttBar
  x: (t: number) => number
  y: number
  testId: string
  beadId?: string
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
      strokeDasharray={bar.style === "waiting" ? "4 3" : undefined}
      className={BAR_CLASS[bar.style]}
      data-style={hollow ? `${bar.style} hollow` : bar.style}
      data-testid={testId}
      data-bead-id={beadId}
    />
  )
}
