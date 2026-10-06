// Time axis for the Chart view (beadbox-eic): pixels per millisecond for a
// zoom level, and tick positions/labels in local time.

export type Zoom = "fit" | "hours" | "days" | "weeks"
export type TickUnit = "hours" | "days" | "weeks"

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS
export const WEEK_MS = 7 * DAY_MS

const UNIT_MS: Record<TickUnit, number> = { hours: HOUR_MS, days: DAY_MS, weeks: WEEK_MS }
// Width of one unit at each fixed zoom level.
const PX_PER_UNIT: Record<TickUnit, number> = { hours: 48, days: 56, weeks: 84 }
// Ticks closer together than this are too dense to label.
const MIN_TICK_PX = 44

export interface TimeDomain {
  start: number
  end: number
}

// Pads the bars' extent so the first and last bar do not touch the edges.
export function paddedDomain(extent: TimeDomain): TimeDomain {
  const pad = Math.max((extent.end - extent.start) * 0.02, HOUR_MS / 2)
  return { start: extent.start - pad, end: extent.end + pad }
}

export function pxPerMs(zoom: Zoom, domain: TimeDomain, width: number): number {
  if (zoom === "fit") return Math.max(width, 1) / Math.max(domain.end - domain.start, HOUR_MS)
  return PX_PER_UNIT[zoom] / UNIT_MS[zoom]
}

// The finest unit whose ticks are still at least MIN_TICK_PX apart.
export function tickUnit(scale: number): TickUnit {
  if (scale * HOUR_MS >= MIN_TICK_PX) return "hours"
  if (scale * DAY_MS >= MIN_TICK_PX) return "days"
  return "weeks"
}

function floorTo(t: number, unit: TickUnit): Date {
  const d = new Date(t)
  d.setMinutes(0, 0, 0)
  if (unit === "hours") return d
  d.setHours(0)
  if (unit === "weeks") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // back to Monday
  return d
}

// Tick times inside the domain, aligned to local hour / midnight / Monday.
export function ticks(domain: TimeDomain, unit: TickUnit): number[] {
  const out: number[] = []
  const d = floorTo(domain.start, unit)
  while (d.getTime() <= domain.end) {
    if (d.getTime() >= domain.start) out.push(d.getTime())
    if (unit === "hours") d.setHours(d.getHours() + 1)
    else d.setDate(d.getDate() + (unit === "weeks" ? 7 : 1))
  }
  return out
}

export function tickLabel(t: number, unit: TickUnit): string {
  const d = new Date(t)
  if (unit === "hours" && d.getHours() !== 0) return `${String(d.getHours()).padStart(2, "0")}:00`
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
