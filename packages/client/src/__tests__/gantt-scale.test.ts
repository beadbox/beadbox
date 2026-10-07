import { describe, expect, test } from "bun:test"
import {
  centeredScrollLeft,
  DAY_MS,
  HOUR_MS,
  levelScale,
  MAX_LEVEL,
  MAX_TICKS,
  NOW_ANCHOR,
  nowScrollLeft,
  MIN_LEVEL,
  MIN_TICK_PX,
  PRESET_LEVEL,
  paddedDomain,
  presetAt,
  pxPerMs,
  STEPS_BETWEEN_PRESETS,
  stepFrom,
  tickLabel,
  ticks,
  tickUnit,
  WEEK_MS,
} from "@/lib/gantt-scale"

const start = new Date(2026, 9, 1, 9, 30).getTime() // local time, Oct 1 09:30
const extent = { start, end: start + 5 * DAY_MS }

describe("gantt scale", () => {
  test("fit maps the whole padded extent onto the available width", () => {
    const domain = paddedDomain(extent)
    expect(domain.start).toBeLessThan(extent.start)
    expect(domain.end).toBeGreaterThan(extent.end)
    const scale = pxPerMs("fit", domain, 1000)
    expect((domain.end - domain.start) * scale).toBeCloseTo(1000)
  })

  test("fixed zoom levels use hour, day and week tick units", () => {
    const domain = paddedDomain(extent)
    expect(tickUnit(pxPerMs("hours", domain, 1000))).toBe("hours")
    expect(tickUnit(pxPerMs("days", domain, 1000))).toBe("days")
    expect(tickUnit(pxPerMs("weeks", domain, 1000))).toBe("weeks")
  })

  test("a changed zoom level rescales: hours are wider than days, days wider than weeks", () => {
    const domain = paddedDomain(extent)
    const width = (zoom: "hours" | "days" | "weeks") => (domain.end - domain.start) * pxPerMs(zoom, domain, 1000)
    expect(width("hours")).toBeGreaterThan(width("days"))
    expect(width("days")).toBeGreaterThan(width("weeks"))
  })

  test("ticks align to local hours, midnights and Mondays", () => {
    const hourly = ticks(extent, "hours")
    expect(hourly[0]).toBe(new Date(2026, 9, 1, 10).getTime())
    expect(hourly[1] - hourly[0]).toBe(HOUR_MS)
    const daily = ticks(extent, "days")
    expect(new Date(daily[0]).getHours()).toBe(0)
    expect(daily.length).toBe(5)
    const weekly = ticks({ start, end: start + 3 * WEEK_MS }, "weeks")
    expect(weekly.every((t) => new Date(t).getDay() === 1)).toBe(true)
  })

  test("labels: hours as HH:00, midnights and days as dates", () => {
    expect(tickLabel(new Date(2026, 9, 1, 14).getTime(), "hours")).toBe("14:00")
    expect(tickLabel(new Date(2026, 9, 2).getTime(), "hours")).not.toContain(":")
    expect(tickLabel(new Date(2026, 9, 2).getTime(), "days")).toMatch(/2/)
  })
})

describe("zoom ladder (beadbox-aqn, design D2)", () => {
  test("levels 0, 4 and 8 are today's Weeks, Days and Hours scales", () => {
    expect(levelScale(PRESET_LEVEL.weeks)).toBe(pxPerMs("weeks", { start: 0, end: 1 }, 1))
    expect(levelScale(PRESET_LEVEL.days)).toBe(pxPerMs("days", { start: 0, end: 1 }, 1))
    expect(levelScale(PRESET_LEVEL.hours)).toBe(pxPerMs("hours", { start: 0, end: 1 }, 1))
    expect([presetAt(0), presetAt(4), presetAt(8), presetAt(5)]).toEqual(["weeks", "days", "hours", null])
  })

  test("a step changes the scale more from Hours than from Days", () => {
    const fromHours = levelScale(8) / levelScale(7)
    const fromDays = levelScale(4) / levelScale(3)
    expect(fromHours).toBeGreaterThan(fromDays)
    expect(fromHours).toBeCloseTo(2.13, 2)
    expect(fromDays).toBeCloseTo(1.47, 2)
  })

  test("4 steps out from Days land on Weeks, with equal ratios in between", () => {
    const ratios = [3, 2, 1, 0].map((l) => levelScale(l + 1) / levelScale(l))
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0], 9)
    expect(presetAt(PRESET_LEVEL.days - STEPS_BETWEEN_PRESETS)).toBe("weeks")
  })

  test("stepFrom goes strictly past a scale in either direction, clamped to the limits", () => {
    const between = Math.sqrt(levelScale(5) * levelScale(6)) // e.g. a Fit scale
    expect(stepFrom(between, 1)).toBe(6)
    expect(stepFrom(between, -1)).toBe(5)
    expect(stepFrom(levelScale(5), 1)).toBe(6) // from exactly a level: the next one
    expect(stepFrom(levelScale(5), -1)).toBe(4)
    expect(stepFrom(levelScale(MAX_LEVEL) * 10, 1)).toBe(MAX_LEVEL)
    expect(stepFrom(levelScale(MIN_LEVEL) / 10, -1)).toBe(MIN_LEVEL)
  })

  test("the zoom-out limit keeps week ticks labellable; one more step would not", () => {
    expect(levelScale(MIN_LEVEL) * WEEK_MS).toBeGreaterThanOrEqual(MIN_TICK_PX)
    expect(levelScale(MIN_LEVEL - 1) * WEEK_MS).toBeLessThan(MIN_TICK_PX)
    expect(MAX_LEVEL - PRESET_LEVEL.hours).toBe(2)
  })
})

describe("centeredScrollLeft (design D3)", () => {
  test("puts the given time at the centre of the viewport", () => {
    const scale = 0.001
    const left = centeredScrollLeft(1_000_000, 0, scale, 400, 10_000)
    expect(left + 400 / 2).toBe(1_000_000 * scale)
  })

  test("is clamped to the scroll range", () => {
    expect(centeredScrollLeft(0, 0, 0.001, 400, 10_000)).toBe(0)
    expect(centeredScrollLeft(1e9, 0, 0.001, 400, 10_000)).toBe(9_600)
    expect(centeredScrollLeft(5, 0, 1, 400, 300)).toBe(0) // content narrower than the view
  })
})

describe("minute tick units (PR #53)", () => {
  test("Hours stays hourly; one step past gives 30 minutes, two steps 15 minutes", () => {
    expect(tickUnit(levelScale(PRESET_LEVEL.hours))).toBe("hours")
    expect(tickUnit(levelScale(PRESET_LEVEL.hours + 1))).toBe("minutes30")
    expect(tickUnit(levelScale(PRESET_LEVEL.hours + 2))).toBe("minutes15")
    expect(PRESET_LEVEL.hours + 2).toBe(MAX_LEVEL) // reachable within today's zoom limit
  })

  test("minute ticks align to local quarter / half hours and are evenly spaced", () => {
    const domain = { start: new Date(2026, 9, 1, 9, 7).getTime(), end: new Date(2026, 9, 1, 11, 0).getTime() }
    const quarters = ticks(domain, "minutes15")
    expect(new Date(quarters[0]).getMinutes()).toBe(15)
    expect(quarters.every((t) => new Date(t).getMinutes() % 15 === 0)).toBe(true)
    expect(quarters.slice(1).every((t, i) => t - quarters[i] === 15 * 60_000)).toBe(true)
    const halves = ticks(domain, "minutes30")
    expect(new Date(halves[0]).getMinutes()).toBe(30)
    expect(halves.every((t) => new Date(t).getMinutes() % 30 === 0)).toBe(true)
  })

  test("labels read HH:MM, and midnight keeps its date", () => {
    expect(tickLabel(new Date(2026, 9, 1, 14, 30).getTime(), "minutes30")).toBe("14:30")
    expect(tickLabel(new Date(2026, 9, 1, 14, 15).getTime(), "minutes15")).toBe("14:15")
    expect(tickLabel(new Date(2026, 9, 1, 9, 0).getTime(), "minutes15")).toBe("09:00")
    expect(tickLabel(new Date(2026, 9, 2, 0, 0).getTime(), "minutes15")).not.toContain(":")
  })

  test("a long range at a minute scale stays within MAX_TICKS", () => {
    const start = new Date(2026, 0, 1).getTime()
    const out = ticks({ start, end: start + 365 * DAY_MS }, "minutes15")
    expect(out.length).toBeLessThanOrEqual(MAX_TICKS)
    expect(out.length).toBeGreaterThan(0)
  })
})

describe("nowScrollLeft (PR #53)", () => {
  test("puts now at 75% of the viewport", () => {
    const left = nowScrollLeft(1_000_000, 0, 0.001, 400, 10_000)
    expect(NOW_ANCHOR).toBe(0.75)
    expect(1_000_000 * 0.001 - left).toBe(300)
  })

  test("is clamped at both ends of the scroll range", () => {
    expect(nowScrollLeft(100_000, 0, 0.001, 400, 10_000)).toBe(0) // now near the start
    expect(nowScrollLeft(9_950_000, 0, 0.001, 400, 10_000)).toBe(9_600) // now near the end
    expect(nowScrollLeft(5, 0, 1, 400, 300)).toBe(0) // content narrower than the view
  })
})
