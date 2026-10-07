// Time axis for the Chart view (beadbox-eic): pixels per millisecond for a
// zoom level, and tick positions/labels in local time.

export type Zoom = "fit" | "hours" | "days" | "weeks"
// Finest first. Minute units appear past the Hours preset (PR #53).
export type TickUnit = "minutes15" | "minutes30" | "hours" | "days" | "weeks"
const TICK_ORDER: TickUnit[] = ["minutes15", "minutes30", "hours", "days", "weeks"]

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS
export const WEEK_MS = 7 * DAY_MS
const MINUTE_MS = 60_000

const UNIT_MS: Record<TickUnit, number> = {
  minutes15: 15 * MINUTE_MS,
  minutes30: 30 * MINUTE_MS,
  hours: HOUR_MS,
  days: DAY_MS,
  weeks: WEEK_MS,
}
// Width of one unit at each fixed zoom level.
const PX_PER_UNIT: Record<"hours" | "days" | "weeks", number> = { hours: 48, days: 56, weeks: 84 }
// Ticks closer together than this are too dense to label.
export const MIN_TICK_PX = 44

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

// Zoom ladder (beadbox-aqn, design D2): Weeks, Days and Hours sit on levels
// 0, 4 and 8, with 4 equal steps (as ratios) between neighbours, so a step
// changes the scale more in the Hours band than in the Days band, and every
// 4th step lands exactly on a preset.
export type Preset = Exclude<Zoom, "fit">
export const PRESET_LEVEL: Record<Preset, number> = { weeks: 0, days: 4, hours: 8 }
export const STEPS_BETWEEN_PRESETS = 4
// -1: the last step whose week ticks are still far enough apart to label.
export const MIN_LEVEL = -1
// 10: two Hours-band steps past Hours.
export const MAX_LEVEL = 10

const presetScale = (preset: Preset) => PX_PER_UNIT[preset] / UNIT_MS[preset]

// Pixels per millisecond at a ladder level.
export function levelScale(level: number): number {
  const preset = presetAt(level)
  if (preset) return presetScale(preset)
  const weeks = presetScale("weeks")
  const days = presetScale("days")
  const hours = presetScale("hours")
  if (level < PRESET_LEVEL.days) return weeks * (days / weeks) ** (level / STEPS_BETWEEN_PRESETS)
  return days * (hours / days) ** ((level - PRESET_LEVEL.days) / STEPS_BETWEEN_PRESETS)
}

export function presetAt(level: number): Preset | null {
  for (const preset of Object.keys(PRESET_LEVEL) as Preset[]) {
    if (PRESET_LEVEL[preset] === level) return preset
  }
  return null
}

// The next ladder level strictly past `scale` in `direction` (+1 zooms in,
// -1 out), clamped to the limits. Used when leaving Fit, whose scale lies
// anywhere between levels.
export function stepFrom(scale: number, direction: 1 | -1): number {
  const tolerance = 1e-9
  if (direction > 0) {
    for (let level = MIN_LEVEL; level <= MAX_LEVEL; level++) {
      if (levelScale(level) > scale * (1 + tolerance)) return level
    }
    return MAX_LEVEL
  }
  for (let level = MAX_LEVEL; level >= MIN_LEVEL; level--) {
    if (levelScale(level) < scale * (1 - tolerance)) return level
  }
  return MIN_LEVEL
}

// scrollLeft that puts time `t` at the centre of a viewport `viewW` wide,
// clamped to the scroll range of content `contentW` wide (design D3).
export function centeredScrollLeft(t: number, domainStart: number, scale: number, viewW: number, contentW: number): number {
  const ideal = (t - domainStart) * scale - viewW / 2
  return Math.min(Math.max(ideal, 0), Math.max(contentW - viewW, 0))
}

// Where a zoom change puts the current time: this fraction of the visible
// width from the left, leaving room for the near plan (PR #53).
export const NOW_ANCHOR = 0.75

// scrollLeft that puts `now` at NOW_ANCHOR of a viewport `viewW` wide,
// clamped to the scroll range of content `contentW` wide.
export function nowScrollLeft(now: number, domainStart: number, scale: number, viewW: number, contentW: number): number {
  const ideal = (now - domainStart) * scale - NOW_ANCHOR * viewW
  return Math.min(Math.max(ideal, 0), Math.max(contentW - viewW, 0))
}

// The finest unit whose ticks are still at least MIN_TICK_PX apart.
export function tickUnit(scale: number): TickUnit {
  for (const unit of TICK_ORDER) {
    if (unit !== "weeks" && scale * UNIT_MS[unit] >= MIN_TICK_PX) return unit
  }
  return "weeks"
}

function floorTo(t: number, unit: TickUnit): Date {
  const d = new Date(t)
  if (unit === "minutes15" || unit === "minutes30") {
    const step = unit === "minutes15" ? 15 : 30
    d.setMinutes(d.getMinutes() - (d.getMinutes() % step), 0, 0)
    return d
  }
  d.setMinutes(0, 0, 0)
  if (unit === "hours") return d
  d.setHours(0)
  if (unit === "weeks") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // back to Monday
  return d
}

// The most ticks one axis may hold (beadbox-8wz): the domain comes from bead
// data, and every tick is drawn twice (axis and gridline).
export const MAX_TICKS = 2_000

// Tick times inside the domain, aligned to local quarter/half hour, hour,
// midnight or Monday.
// A domain too long for `unit` gets a coarser unit, then every Nth week, so
// the result never exceeds MAX_TICKS and the loop never runs past it.
export function ticks(domain: TimeDomain, unit: TickUnit): number[] {
  const span = Math.max(domain.end - domain.start, 0)
  if (!Number.isFinite(span)) return []
  let u = unit
  while (u !== "weeks" && span / UNIT_MS[u] > MAX_TICKS) u = TICK_ORDER[TICK_ORDER.indexOf(u) + 1]
  const stride = u === "weeks" ? Math.max(1, Math.ceil(span / WEEK_MS / MAX_TICKS)) : 1
  const out: number[] = []
  const d = floorTo(domain.start, u)
  // +2 covers the floored first tick and a DST-shortened step.
  for (let i = 0; d.getTime() <= domain.end && i < MAX_TICKS + 2; i++) {
    if (d.getTime() >= domain.start && out.length < MAX_TICKS) out.push(d.getTime())
    if (u === "minutes15") d.setMinutes(d.getMinutes() + 15)
    else if (u === "minutes30") d.setMinutes(d.getMinutes() + 30)
    else if (u === "hours") d.setHours(d.getHours() + 1)
    else d.setDate(d.getDate() + (u === "weeks" ? 7 * stride : 1))
  }
  return out
}

export function tickLabel(t: number, unit: TickUnit): string {
  const d = new Date(t)
  const midnight = d.getHours() === 0 && d.getMinutes() === 0
  const hh = String(d.getHours()).padStart(2, "0")
  if ((unit === "minutes15" || unit === "minutes30") && !midnight) return `${hh}:${String(d.getMinutes()).padStart(2, "0")}`
  if (unit === "hours" && d.getHours() !== 0) return `${hh}:00`
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
