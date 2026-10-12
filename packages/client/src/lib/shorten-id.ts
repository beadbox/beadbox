// beadbox-d0d (GitHub #55): fit an id into the characters its column has.
//
// The old form was always first8 + "..." + last6, 17 characters: longer than
// a 15- or 16-character id, and wider than the epic row's id column, so the
// type icon painted over it. Now an id that fits is shown in full, and a
// longer one becomes head + "…" + tail of exactly `maxChars` characters: the
// result is never longer than the id or the budget. The tail keeps the part
// that tells siblings apart (the number, a dotted child suffix).

const ELLIPSIS = "…"

export function shortenId(id: string, maxChars = 14): string {
  const max = Math.max(0, Math.floor(maxChars))
  if (id.length <= max) return id
  if (max < 3) return id.slice(0, max)
  const tail = Math.floor((max - 1) / 2)
  const head = max - 1 - tail
  return `${id.slice(0, head)}${ELLIPSIS}${id.slice(-tail)}`
}
