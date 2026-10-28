// beadbox-816g.1: the one shared due formatter. Every case passes an explicit
// time zone so the result does not depend on the machine running the suite.

import { describe, expect, test } from "bun:test"
import { describeDueAt, formatDueAt } from "../lib/due-format"

const NY = "America/New_York"
const BERLIN = "Europe/Berlin"

describe("formatDueAt (beadbox-816g.1)", () => {
  test("a timed value shows date and time in the viewer's zone", () => {
    expect(formatDueAt(new Date("2026-10-28T04:30:00Z"), NY)).toBe("Oct 28, 12:30 AM")
  })

  test("local midnight shows the date alone", () => {
    expect(formatDueAt(new Date("2026-10-28T04:00:00Z"), NY)).toBe("Oct 28")
  })

  test("UTC midnight that is not local midnight shows the local date and time", () => {
    expect(formatDueAt(new Date("2026-10-28T00:00:00Z"), NY)).toBe("Oct 27, 8:00 PM")
  })

  test("another viewer zone renders the same instant in that zone", () => {
    // EU summer time ended 2026-10-25, so Berlin is UTC+1 on Oct 28.
    expect(formatDueAt(new Date("2026-10-28T04:30:00Z"), BERLIN)).toBe("Oct 28, 5:30 AM")
    // UTC+2 before the change.
    expect(formatDueAt(new Date("2026-10-20T04:30:00Z"), BERLIN)).toBe("Oct 20, 6:30 AM")
  })

  test("a winter date-only value is midnight by the zone's offset at the due instant", () => {
    // EST midnight. The check must not use today's (summer) offset.
    expect(formatDueAt(new Date("2026-02-14T05:00:00Z"), NY)).toBe("Feb 14")
  })

  test("DST end day: a morning value uses the post-transition offset", () => {
    expect(formatDueAt(new Date("2026-11-01T11:00:00Z"), NY)).toBe("Nov 1, 6:00 AM")
  })

  test("DST end day: midnight before the transition (EDT) and the next midnight (EST)", () => {
    expect(formatDueAt(new Date("2026-11-01T04:00:00Z"), NY)).toBe("Nov 1")
    expect(formatDueAt(new Date("2026-11-02T05:00:00Z"), NY)).toBe("Nov 2")
  })

  test("both sides of midnight show a time", () => {
    expect(formatDueAt(new Date("2026-10-28T03:59:00Z"), NY)).toBe("Oct 27, 11:59 PM")
    expect(formatDueAt(new Date("2026-10-28T04:01:00Z"), NY)).toBe("Oct 28, 12:01 AM")
  })

  test("seconds past midnight are not midnight", () => {
    expect(formatDueAt(new Date("2026-10-28T04:00:30Z"), NY)).toBe("Oct 28, 12:00 AM")
  })

  test("accepts the ISO string bd returns", () => {
    expect(formatDueAt("2026-10-28T04:30:00Z", NY)).toBe("Oct 28, 12:30 AM")
  })

  test("an empty or unparseable value renders nothing", () => {
    expect(formatDueAt("", NY)).toBe("")
    expect(formatDueAt("not a date", NY)).toBe("")
    expect(formatDueAt(new Date(Number.NaN), NY)).toBe("")
  })

  test("uses a plain space before AM/PM", () => {
    expect(formatDueAt(new Date("2026-10-28T16:05:00Z"), NY)).toBe("Oct 28, 12:05 PM")
    expect(formatDueAt(new Date("2026-10-28T16:05:00Z"), NY)).not.toMatch(/[  ]/)
  })
})

// beadbox-816g.2: the relative hint and "overdue", with a fixed now.
describe("describeDueAt (beadbox-816g.2)", () => {
  const NOW = new Date("2026-10-28T19:00:00Z") // 3:00 PM in New York
  const MIN = 60_000
  const HOUR = 60 * MIN
  const at = (offsetMs: number, timeZone = NY) =>
    describeDueAt(new Date(NOW.getTime() + offsetMs), { now: NOW, timeZone })

  test("within 24 h: whole hours, and minutes under an hour", () => {
    expect(at(3 * HOUR).text).toBe("Oct 28, 6:00 PM · in 3 h")
    expect(at(40 * MIN).text).toBe("Oct 28, 3:40 PM · in 40 min")
    expect(at(59 * MIN).text).toBe("Oct 28, 3:59 PM · in 59 min")
    expect(at(HOUR).text).toBe("Oct 28, 4:00 PM · in 1 h")
  })

  test("both sides of the 24 h boundary", () => {
    expect(at(23 * HOUR + 59 * MIN).text).toBe("Oct 29, 2:59 PM · in 23 h")
    expect(at(24 * HOUR).text).toBe("Oct 29, 3:00 PM")
    expect(at(24 * HOUR + MIN).text).toBe("Oct 29, 3:01 PM")
  })

  test("a value read a few seconds after it was set keeps its hour", () => {
    // bd --due +3h, rendered 10 s later: the hint agrees with the minute shown.
    expect(at(3 * HOUR - 10_000).text).toBe("Oct 28, 5:59 PM · in 3 h")
    expect(at(40 * MIN - 10_000).text).toBe("Oct 28, 3:39 PM · in 40 min")
    // Rounds to 24 h, which is outside the window: no hint, never "in 24 h".
    expect(at(24 * HOUR - 20_000).text).toBe("Oct 29, 2:59 PM")
  })

  test("under a minute away reads in 1 min", () => {
    expect(at(30_000).text).toBe("Oct 28, 3:00 PM · in 1 min")
  })

  test("both sides of now: exactly at due and past due are overdue", () => {
    expect(at(0)).toEqual({ text: "Oct 28, 3:00 PM · overdue", overdue: true })
    expect(at(-MIN)).toEqual({ text: "Oct 28, 2:59 PM · overdue", overdue: true })
    expect(at(-7 * 24 * HOUR)).toEqual({ text: "Oct 21, 3:00 PM · overdue", overdue: true })
    expect(at(MIN).overdue).toBe(false)
    expect(at(3 * HOUR).overdue).toBe(false)
  })

  test("DST crossing: the hint is a difference of instants", () => {
    const now = new Date("2026-10-31T12:00:00Z")
    const due = new Date("2026-11-01T11:00:00Z") // DST ends 06:00Z in between
    expect(describeDueAt(due, { now, timeZone: NY }).text).toBe("Nov 1, 6:00 AM · in 23 h")
  })

  test("a midnight-alone value still gets the hint", () => {
    // Tonight's local midnight (EDT) is 5 h after 7:00 PM.
    const now = new Date("2026-10-28T23:00:00Z")
    const due = new Date("2026-10-29T04:00:00Z")
    expect(describeDueAt(due, { now, timeZone: NY }).text).toBe("Oct 29 · in 5 h")
  })

  test("a past date-only value reads date · overdue", () => {
    const due = new Date("2026-01-01T05:00:00Z") // EST midnight
    expect(describeDueAt(due, { now: NOW, timeZone: NY })).toEqual({
      text: "Jan 1 · overdue",
      overdue: true,
    })
  })

  test("a zone change moves the date and time, not the hint", () => {
    expect(at(3 * HOUR, BERLIN).text).toBe("Oct 28, 11:00 PM · in 3 h")
    expect(at(-MIN, BERLIN).text).toBe("Oct 28, 7:59 PM · overdue")
  })

  test("an empty or unparseable value renders nothing and is not overdue", () => {
    expect(describeDueAt("", { now: NOW, timeZone: NY })).toEqual({ text: "", overdue: false })
    expect(describeDueAt("not a date", { now: NOW, timeZone: NY })).toEqual({
      text: "",
      overdue: false,
    })
  })

  test("now defaults to the clock at the call", () => {
    expect(describeDueAt(new Date(Date.now() + 3 * HOUR + 30 * MIN)).text).toEndWith(" · in 3 h")
    expect(describeDueAt(new Date(Date.now() - MIN)).overdue).toBe(true)
  })
})
