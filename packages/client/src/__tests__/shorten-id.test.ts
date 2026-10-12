// beadbox-d0d (GitHub #55): an epic row's id must never be drawn under the
// type icon. Shortening may only make an id shorter, never longer, and must
// fit the budget its column gives it.

import { describe, expect, test } from "bun:test"
import { shortenId } from "../lib/shorten-id"

/** Ids of the lengths the bead names, with a 12-char prefix where it fits. */
const IDS: Record<number, string> = {
  9: "bb-a1b2c3",
  14: "longprefix-a1b",
  15: "longprefix-a1b2",
  17: "longprefixx-a1b2c",
  24: "longprefixab-a1b2c3.12.7",
}

describe("shortenId never makes an id longer (AC2)", () => {
  for (const max of [14, 13]) {
    for (const [n, id] of Object.entries(IDS)) {
      test(`${n} chars at max ${max}`, () => {
        expect(id).toHaveLength(Number(n))
        const shown = shortenId(id, max)
        expect(shown.length).toBeLessThanOrEqual(id.length)
        expect(shown.length).toBeLessThanOrEqual(max)
        if (id.length <= max) expect(shown).toBe(id)
      })
    }
  }
})

test("the 14/15 boundary at the default budget", () => {
  expect(shortenId(IDS[14], 14)).toBe(IDS[14])
  const shown = shortenId(IDS[15], 14)
  expect(shown).toHaveLength(14)
  expect(shown).not.toBe(IDS[15])
})

test("a shortened id keeps its prefix and its suffix, with one ellipsis", () => {
  const shown = shortenId(IDS[24], 13)
  expect(shown).toHaveLength(13)
  expect(shown.startsWith("longpr")).toBe(true)
  // max 13: head 6 + "…" + tail 6
  expect(shown).toBe("longpr…3.12.7")
  expect(shown.split("…")).toHaveLength(2)
})

test("a degenerate budget still never exceeds it", () => {
  expect(shortenId(IDS[24], 2)).toHaveLength(2)
  expect(shortenId(IDS[24], 0)).toBe("")
})
