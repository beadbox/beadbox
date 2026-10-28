// beadbox-816g.1: the one shared due formatter. Every case passes an explicit
// time zone so the result does not depend on the machine running the suite.

import { describe, expect, test } from "bun:test"
import { formatDueAt } from "../lib/due-format"

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
