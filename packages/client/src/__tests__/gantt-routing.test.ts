import { describe, expect, test } from "bun:test"
import { type Point, type RowGeometry, routeConnector, routeConnectors, sharedSegments, TakenX } from "@/lib/gantt-routing"

const ROW_H = 28
const BAR_H = 14 // as drawn by gantt-chart.tsx

const geo = (bars: Array<[number, number] | null>): RowGeometry => ({ rowHeight: ROW_H, bars })
const mid = (row: number) => row * ROW_H + ROW_H / 2

// Does an axis-aligned segment pass through the open interior of a bar?
function entersBar(a: Point, b: Point, bar: [number, number], row: number): boolean {
  const top = mid(row) - BAR_H / 2
  const bottom = mid(row) + BAR_H / 2
  const [x1, x2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
  const [y1, y2] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
  const xOverlap = Math.min(x2, bar[1]) - Math.max(x1, bar[0])
  const yOverlap = Math.min(y2, bottom) - Math.max(y1, top)
  if (a[1] === b[1]) return a[1] > top && a[1] < bottom && xOverlap > 0
  return a[0] > bar[0] && a[0] < bar[1] && yOverlap > 0
}

function crossings(path: Point[], g: RowGeometry): string[] {
  const hits: string[] = []
  for (let i = 0; i + 1 < path.length; i++) {
    g.bars.forEach((bar, row) => {
      if (bar && entersBar(path[i], path[i + 1], bar, row)) hits.push(`segment ${i} enters row ${row}`)
    })
  }
  return hits
}

function expectWellFormed(path: Point[], g: RowGeometry, fromRow: number, toRow: number) {
  const from = g.bars[fromRow]!
  const to = g.bars[toRow]!
  expect(path[0]).toEqual([from[1], mid(fromRow)]) // leaves the end edge
  expect(path[path.length - 1]).toEqual([to[0], mid(toRow)]) // ends on the start edge
  const beforeLast = path[path.length - 2]
  expect(beforeLast[1]).toBe(mid(toRow)) // arrives horizontally...
  expect(beforeLast[0]).toBeLessThan(to[0]) // ...from the left, heading right
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i], path[i + 1]]
    expect(a[0] === b[0] || a[1] === b[1]).toBe(true) // axis-aligned
  }
  expect(crossings(path, g)).toEqual([])
}

describe("routeConnector", () => {
  test("control: the old elbow routing is caught crossing bars", () => {
    // gantt-chart.tsx before beadbox-eic.7: bend right of both, then back left into the start.
    const g = geo([
      [0, 200],
      [50, 300],
    ])
    const bend = Math.max(200, 50 - 8) + 6
    const old: Point[] = [[200, mid(0)], [bend, mid(0)], [bend, mid(1)], [49, mid(1)]]
    expect(crossings(old, g).length).toBeGreaterThan(0)
  })

  test("gap between the bars: one vertical run between them", () => {
    const g = geo([
      [0, 100],
      [200, 300],
    ])
    const path = routeConnector({ fromRow: 0, toRow: 1 }, g)
    expectWellFormed(path, g, 0, 1)
    expect(path.length).toBe(4)
    expect(path.every(([x]) => x >= 100 && x <= 200)).toBe(true)
  })

  test("bars overlapping in time: runs along the boundary between rows", () => {
    const g = geo([
      [0, 200],
      [50, 300],
    ])
    const path = routeConnector({ fromRow: 0, toRow: 1 }, g)
    expectWellFormed(path, g, 0, 1)
    expect(path.some(([, y]) => y === ROW_H)).toBe(true)
  })

  test("rows in between: the vertical run avoids their bars", () => {
    const g = geo([
      [0, 50],
      [60, 400],
      [300, 350],
    ])
    const path = routeConnector({ fromRow: 0, toRow: 2 }, g)
    expectWellFormed(path, g, 0, 2)
  })

  test("upward edges work the same way", () => {
    const g = geo([
      [50, 300],
      [120, 160],
      [0, 200],
    ])
    const path = routeConnector({ fromRow: 2, toRow: 0 }, g)
    expectWellFormed(path, g, 2, 0)
  })

  test("lines without a bar (collapsed or empty) are free space", () => {
    const g = geo([[0, 100], null, [20, 60]])
    expectWellFormed(routeConnector({ fromRow: 0, toRow: 2 }, g), g, 0, 2)
  })

  test("never enters any bar, over many generated layouts", () => {
    let seed = 7
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    for (let n = 0; n < 2_000; n++) {
      const rows = 2 + Math.floor(rand() * 8)
      const bars: Array<[number, number] | null> = []
      for (let r = 0; r < rows; r++) {
        if (rand() < 0.1) {
          bars.push(null)
          continue
        }
        const start = Math.round(rand() * 600)
        bars.push([start, start + 3 + Math.round(rand() * 300)])
      }
      const fromRow = Math.floor(rand() * rows)
      let toRow = Math.floor(rand() * rows)
      if (toRow === fromRow) toRow = (toRow + 1) % rows
      if (!bars[fromRow] || !bars[toRow]) continue
      const g = geo(bars)
      const path = routeConnector({ fromRow, toRow }, g)
      const hits = crossings(path, g)
      if (hits.length) throw new Error(`layout ${n}: ${JSON.stringify({ bars, fromRow, toRow, path, hits })}`)
      expectWellFormed(path, g, fromRow, toRow)
    }
  })
})

describe("routeConnectors — lanes", () => {
  const check = (bars: Array<[number, number] | null>, edges: Array<[number, number]>) => {
    const g = geo(bars)
    const paths = routeConnectors(
      edges.map(([fromRow, toRow]) => ({ fromRow, toRow })),
      g,
    )
    for (const path of paths) expect(crossings(path, g)).toEqual([])
    expect(sharedSegments(paths)).toEqual([])
    return paths
  }

  test("a chain of overlapping beads, like group 5 in the screenshot", () => {
    // Each bead blocked by the one before; all started together and closed close together.
    check(
      [
        [0, 104],
        [0, 100],
        [0, 102],
        [0, 96],
      ],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    )
  })

  test("fan-out: one predecessor, several dependents, leaving at different heights", () => {
    const paths = check(
      [
        [0, 100],
        [200, 300],
        [210, 260],
        [180, 240],
      ],
      [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    )
    const exits = paths.map((p) => p[0][1])
    expect(new Set(exits).size).toBe(3)
    for (const p of paths) expect(Math.abs(p[0][1] - mid(0))).toBeLessThan(BAR_H / 2) // still on the end edge
  })

  test("fan-in: several predecessors, one dependent, arriving at different heights", () => {
    const paths = check(
      [
        [0, 100],
        [0, 140],
        [0, 120],
        [300, 400],
      ],
      [
        [0, 3],
        [1, 3],
        [2, 3],
      ],
    )
    const arrivals = paths.map((p) => p[p.length - 1][1])
    expect(new Set(arrivals).size).toBe(3)
    for (const p of paths) expect(Math.abs(p[p.length - 1][1] - mid(3))).toBeLessThan(BAR_H / 2)
  })

  test("random layouts with a few connectors: no shared segments, no bar crossings", () => {
    let seed = 11
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    for (let n = 0; n < 500; n++) {
      const rows = 3 + Math.floor(rand() * 6)
      const bars: Array<[number, number]> = []
      for (let r = 0; r < rows; r++) {
        const start = Math.round(rand() * 400)
        bars.push([start, start + 3 + Math.round(rand() * 200)])
      }
      const edges: Array<[number, number]> = []
      const count = 2 + Math.floor(rand() * 3)
      for (let e = 0; e < count; e++) {
        const a = Math.floor(rand() * rows)
        let b = Math.floor(rand() * rows)
        if (a === b) b = (b + 1) % rows
        if (!edges.some(([x, y]) => x === a && y === b)) edges.push([a, b])
      }
      const g = geo(bars)
      const paths = routeConnectors(
        edges.map(([fromRow, toRow]) => ({ fromRow, toRow })),
        g,
      )
      const shared = sharedSegments(paths)
      const hits = paths.flatMap((path) => crossings(path, g))
      if (shared.length || hits.length) {
        throw new Error(`layout ${n}: ${JSON.stringify({ bars, edges, paths, shared, hits })}`)
      }
    }
  })
})

// beadbox-8wz: TakenX replaced a linear scan that made routing quadratic; it
// must answer exactly what the scan did ("within 1px of a taken x").
describe("TakenX", () => {
  test("near() matches a linear scan, fractional and negative positions included", () => {
    let seed = 11
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const xs = Array.from({ length: 400 }, () => Math.round((rnd() * 400 - 100) * 4) / 4)
    const taken = TakenX.from(xs)
    for (let i = 0; i < 4_000; i++) {
      const probe = rnd() * 420 - 110
      expect(taken.near(probe)).toBe(xs.some((t) => Math.abs(t - probe) < 1))
    }
    for (const t of [0, -1, 1, 9.5]) {
      for (const d of [-1, -0.999, 0, 0.999, 1]) expect(TakenX.from([t]).near(t + d)).toBe(Math.abs(d) < 1)
    }
  })
})
