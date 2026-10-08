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
    // An earlier gantt-chart.tsx: bend right of both, then back left into the start.
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

// PR #54: the layout from a user's screenshot, with "Links across epics"
// on. Every stretch between the two ends of 3.3 -> 5.1 is covered in some row
// in between, and the old single-vertical router sent whichever connector was
// routed second on a detour of more than 800 px around all the bars.
describe("routeConnectors — stacked epics (screenshot regression)", () => {
  const bars: Array<[number, number] | null> = [
    [3, 850], [748, 850], [748, 850], [543, 748], [645, 748], [543, 645], [135, 237],
    [135, 237], [237, 543], [440, 543], [339, 440], [237, 339], [3, 135], [32, 135], [0, 32],
  ]
  const inEpic = [
    { fromRow: 5, toRow: 4 },
    { fromRow: 11, toRow: 10 },
    { fromRow: 10, toRow: 9 },
    { fromRow: 14, toRow: 13 },
  ]
  const crossEpic = [
    { fromRow: 9, toRow: 2 }, // 3.3 -> final check (the one from the screenshot)
    { fromRow: 4, toRow: 2 },
    { fromRow: 13, toRow: 2 },
    { fromRow: 7, toRow: 2 },
  ]
  const permutations = <T,>(items: T[]): T[][] =>
    items.length <= 1 ? [items] : items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]))

  // Local: no further left than the leftmost bar end it joins, and no further
  // right than the rightmost one, each with two stubs of slack (design D3).
  const offBounds = (edge: { fromRow: number; toRow: number }, path: Point[]) => {
    const from = bars[edge.fromRow]!
    const to = bars[edge.toRow]!
    const lo = Math.min(from[0], to[0]) - 2 * 8
    const hi = Math.max(from[1], to[1]) + 2 * 8
    const xs = path.map(([x]) => x)
    return Math.min(...xs) < lo || Math.max(...xs) > hi ? `${edge.fromRow}->${edge.toRow} spans ${Math.min(...xs)}..${Math.max(...xs)}, allowed ${lo}..${hi}` : null
  }

  test("in every routing order, every connector stays local, enters no bar and shares no segment", () => {
    const g = geo(bars)
    for (const order of permutations(crossEpic)) {
      const edges = [...inEpic, ...order]
      const paths = routeConnectors(edges, g)
      const problems = [
        ...edges.map((e, i) => offBounds(e, paths[i])).filter(Boolean),
        ...paths.flatMap((p) => crossings(p, g)),
        ...sharedSegments(paths).map(([a, b]) => `shared segment between ${a} and ${b}`),
      ]
      if (problems.length) throw new Error(`order ${order.map((e) => `${e.fromRow}->${e.toRow}`).join(", ")}: ${problems.join("; ")}`)
    }
  })
})

// PR #54: dense charts, as with "Links across epics" on.
// A soft lane cost (113 of these layouts) and a gap path forced onto a taken
// position produced shared segments, and six runs overlapping on one row
// boundary made the lane post-pass loop forever.
describe("routeConnectors — dense layouts", () => {
  // Vertical stretches two connectors share; crossing at a point is fine.
  const sharedVerticals = (paths: Point[][]) => {
    const verticals = paths.flatMap((path, p) =>
      path.slice(1).flatMap((b, k) => (path[k][0] === b[0] ? [{ p, x: b[0], lo: Math.min(path[k][1], b[1]), hi: Math.max(path[k][1], b[1]) }] : [])),
    )
    return verticals.filter((s, i) => verticals.some((t, j) => j > i && t.p !== s.p && t.x === s.x && t.lo < s.hi && s.lo < t.hi))
  }

  test("5,000 layouts with 6-20 rows and 4-12 connectors finish, cross no bar, and share at most a rare boundary stretch", () => {
    let seed = 99
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    let withShared = 0
    for (let n = 0; n < 5_000; n++) {
      const rows = 6 + Math.floor(rand() * 15)
      const bars: Array<[number, number]> = []
      for (let r = 0; r < rows; r++) {
        const start = Math.round(rand() * 400)
        bars.push([start, start + 3 + Math.round(rand() * 200)])
      }
      const edges: Array<{ fromRow: number; toRow: number }> = []
      const count = 4 + Math.floor(rand() * 9)
      for (let e = 0; e < count; e++) {
        const a = Math.floor(rand() * rows)
        let b = Math.floor(rand() * rows)
        if (a === b) b = (b + 1) % rows
        if (!edges.some((x) => x.fromRow === a && x.toRow === b)) edges.push({ fromRow: a, toRow: b })
      }
      const g = geo(bars)
      const paths = routeConnectors(edges, g)
      const hits = paths.flatMap((path) => crossings(path, g))
      const verticals = sharedVerticals(paths)
      if (hits.length || verticals.length) throw new Error(`layout ${n}: ${JSON.stringify({ bars, edges, hits, verticals })}`)
      if (sharedSegments(paths).length) withShared++
    }
    // Only an overflowing boundary (more runs than its five lanes) may share.
    expect(withShared).toBeLessThanOrEqual(25)
    // 5,000 layouts take several seconds, past bun's 5 s default on a loaded machine.
  }, 60_000)
})

// beadbox-6iy (sec FIX-B): the staircase is a DP over every line a connector
// crosses, ~R^3 work per connector, rerun on every render. One dependency
// spanning hundreds of lines (one large epic, or a link across epics) froze the
// window. Past a work budget the connector takes the single-vertical route.
describe("routeConnector — long connectors stay bounded", () => {
  // Bars with distinct edges on every line, so the staircase's candidate set
  // really is ~10 per line; the dependent starts left of where its blocker
  // ends, so the single-vertical gap path is never available.
  function longLayout(span: number): RowGeometry {
    const bars: Array<[number, number] | null> = []
    bars.push([400, 600]) // blocker, row 0
    for (let r = 1; r < span; r++) {
      const start = (r * 37) % 500
      bars.push([start, start + 120 + (r % 7) * 10])
    }
    bars.push([100, 300]) // dependent, row `span`
    return geo(bars)
  }

  for (const span of [300, 1_000]) {
    test(`a connector across ${span} lines routes in well under a second, crossing no bar`, () => {
      const g = longLayout(span)
      const started = performance.now()
      const path = routeConnector({ fromRow: 0, toRow: span }, g)
      const elapsed = performance.now() - started
      expect(elapsed).toBeLessThan(1_000) // unbounded, this ran for minutes
      expectWellFormed(path, g, 0, span)
    })
  }

  test("routeConnectors with several long links across epics stays bounded too", () => {
    const g = longLayout(1_000)
    const edges = [0, 1, 2, 3, 4].map((k) => ({ fromRow: k, toRow: 1_000 - k }))
    const started = performance.now()
    const paths = routeConnectors(edges, g)
    expect(performance.now() - started).toBeLessThan(2_000)
    for (const path of paths) expect(crossings(path, g)).toEqual([])
  })

  test("a short connector still gets the staircase (the budget only catches long ones)", () => {
    // Same shape as the long layout, but only 6 lines between the bars.
    const g = longLayout(7)
    const path = routeConnector({ fromRow: 0, toRow: 7 }, g)
    expectWellFormed(path, g, 0, 7)
    const verticals = path.slice(1).filter((p, i) => p[0] === path[i][0]).length
    expect(verticals).toBeGreaterThan(1) // stepped, not a single vertical run
  })
})
