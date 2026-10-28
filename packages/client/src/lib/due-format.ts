// beadbox-816g.1: the one formatter for a bead's due value (pm/spec.md §4.3,
// "Due time"). bd stores due_at as an instant; a date-only entry stores local
// midnight. Midnight in the viewer's zone renders the date alone ("Oct 28"),
// anything else renders date and time ("Oct 28, 12:30 AM").
//
// timeZone is for tests; callers omit it and get the viewer's zone.
//
// Date and time are formatted separately and joined with ", ": a single
// toLocaleString with both renders "Oct 28 at 12:30 AM" on JSC/WebKit (CLDR's
// "at" pattern), and newer ICU puts U+202F before AM/PM, which is normalised
// so every engine renders the same text.

const NARROW_SPACES = /[  ]/g

function isLocalMidnight(date: Date, timeZone?: string): boolean {
  // Offset at the due instant, not today's: a winter date-only value is
  // still midnight when viewed in summer.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date)
  return parts
    .filter((p) => p.type === "hour" || p.type === "minute" || p.type === "second")
    .every((p) => Number(p.value) === 0)
}

export function formatDueAt(dueAt: Date | string, timeZone?: string): string {
  if (!dueAt) return ""
  const date = new Date(dueAt)
  if (Number.isNaN(date.getTime())) return ""

  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone })
  if (isLocalMidnight(date, timeZone)) return day

  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })
  return `${day}, ${time.replace(NARROW_SPACES, " ")}`
}
