import { describe, expect, test } from "bun:test"
import { DAY_MS, HOUR_MS, paddedDomain, pxPerMs, tickLabel, ticks, tickUnit, WEEK_MS } from "@/lib/gantt-scale"

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
