// The palette sweep moved semantic colours onto tokens, but a few lists are
// IDENTITY palettes: "which author", "which epic", "which step". Their whole
// purpose is that adjacent entries differ, so collapsing them onto the three
// tone tokens makes two authors share a stripe.
//
// This exists because that mistake was actually made during the sweep: a bulk
// token conversion rewrote six distinct author colours into two repeated ones.
// The entries stay literal on purpose — a saturated 500 reads on a light card
// as well as a dark one, and there is no token for "author #4".
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"

const SRC = join(import.meta.dir, "..")

function listAfter(file: string, marker: string): string[] {
  const src = readFileSync(join(SRC, file), "utf-8")
  const start = src.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf("]", start)
  return [...src.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

describe("identity palettes stay distinct", () => {
  const cases: Array<{ file: string; marker: string; min: number }> = [
    { file: "components/bead-detail-helpers.ts", marker: "const authorColors = [", min: 6 },
    { file: "components/formula-dag.tsx", marker: "const ACCENT_COLORS = [", min: 8 },
  ]

  for (const { file, marker, min } of cases) {
    test(`${marker.replace(/const (\w+).*/, "$1")} has no repeated entry`, () => {
      const entries = listAfter(file, marker)
      expect(entries.length).toBeGreaterThanOrEqual(min)
      expect(new Set(entries).size).toBe(entries.length)
    })
  }

  test("the epic-tree left-border cycle has no repeated entry", () => {
    const src = readFileSync(join(SRC, "components/epic-tree.tsx"), "utf-8")
    const entries = [...src.matchAll(/"(border-l-[a-z]+-\d{2,3})"/g)].map((m) => m[1])
    expect(entries.length).toBeGreaterThanOrEqual(5)
    expect(new Set(entries).size).toBe(entries.length)
  })

  test("the epic-tree-skeleton cycle has no repeated entry, and mirrors epic-tree", () => {
    const skel = readFileSync(join(SRC, "components/epic-tree-skeleton.tsx"), "utf-8")
    const entries = [...skel.matchAll(/"(border-l-[a-z]+-\d{2,3})"/g)].map((m) => m[1])
    expect(entries.length).toBeGreaterThanOrEqual(3)
    expect(new Set(entries).size).toBe(entries.length)
    // The skeleton stands in for the real tree, so it must draw from the same
    // palette rather than drifting to its own.
    const tree = readFileSync(join(SRC, "components/epic-tree.tsx"), "utf-8")
    const treeEntries = new Set(
      [...tree.matchAll(/"(border-l-[a-z]+-\d{2,3})"/g)].map((m) => m[1]),
    )
    for (const e of entries) expect(treeEntries.has(e)).toBe(true)
  })

  test("the bead-table row cycle has no repeated entry", () => {
    const src = readFileSync(join(SRC, "components/bead-table.tsx"), "utf-8")
    const entries = [...src.matchAll(/"border-l-2 (border-l-[a-z]+-\d{2,3}\/\d+)"/g)].map((m) => m[1])
    expect(entries.length).toBeGreaterThanOrEqual(4)
    expect(new Set(entries).size).toBe(entries.length)
  })
})

describe("tone hovers actually change something", () => {
  // The sweep collapsed shade pairs onto one token: `text-emerald-400
  // hover:text-emerald-300` became `text-success-text hover:text-success-text`,
  // an inert hover. Eight of these shipped before this test existed. A hover
  // on a tone token has to differ from its base — by alpha on a text colour,
  // or shadcn's /90 on a solid fill.
  const TONES = "warning|info|success|destructive|primary"
  const scanned = new Set([".ts", ".tsx"])

  function collect(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") continue
      const full = join(dir, e.name)
      if (e.isDirectory()) out.push(...collect(full))
      else if (scanned.has(extname(e.name))) out.push(full)
    }
    return out
  }

  test("no `X hover:X` pair on a tone token anywhere in src/", () => {
    const offenders: string[] = []
    for (const file of collect(SRC)) {
      const lines = readFileSync(file, "utf-8").split("\n")
      lines.forEach((line, i) => {
        for (const util of ["text", "bg", "border", "ring"]) {
          const base = new RegExp(`(?<!hover:)\\b${util}-(${TONES})(-text)?\\b(?![/\\w-])`, "g")
          const hover = new RegExp(`hover:${util}-(${TONES})(-text)?\\b(?![/\\w-])`, "g")
          const b = new Set([...line.matchAll(base)].map((m) => m[0]))
          const h = new Set([...line.matchAll(hover)].map((m) => m[0].replace("hover:", "")))
          for (const x of b) {
            if (h.has(x)) {
              offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} ${util}-… ${x}`)
            }
          }
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
