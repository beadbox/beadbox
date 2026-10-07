// Dependency connector routing for the Chart view (PR #51).
// Pure geometry: a connector leaves the predecessor's end edge and ends on the
// dependent's start edge, travelling only through space no bar occupies. Bars
// are vertically centred in fixed-height rows, so the boundary between two
// rows never holds a bar; when the bars leave no usable gap, the connector
// runs along those boundaries.

export type Point = [number, number]

export interface RowGeometry {
  rowHeight: number
  // Drawn [x1, x2] of the bar in each line (null: the line has no bar).
  bars: Array<[number, number] | null>
}

export interface ConnectorEdge {
  fromRow: number // predecessor's line
  toRow: number // dependent's line
}

// Vertical x positions connectors already use. "Taken" means within 1px of one;
// bucketing by whole pixels makes that check constant-time instead of a scan
// of every vertical so far, which made routing quadratic (beadbox-8wz: 3s per
// render for ~3,000 connectors).
export class TakenX {
  private readonly buckets = new Map<number, number[]>()

  static from(xs: Iterable<number>): TakenX {
    const taken = new TakenX()
    for (const x of xs) taken.add(x)
    return taken
  }

  add(x: number): void {
    const key = Math.floor(x)
    const bucket = this.buckets.get(key)
    if (bucket) bucket.push(x)
    else this.buckets.set(key, [x])
  }

  // Is any taken x within 1px of x? Those all sit in the neighbouring buckets.
  near(x: number): boolean {
    const key = Math.floor(x)
    for (let k = key - 1; k <= key + 1; k++) {
      if (this.buckets.get(k)?.some((t) => Math.abs(t - x) < 1)) return true
    }
    return false
  }
}

export const STUB = 8 // horizontal run out of an end edge / into a start edge
const CLEARANCE = 3 // keep vertical runs this far from any bar
export const LANE = 4 // spacing between connectors that would otherwise share a segment

// Is x clear of every bar in the lines strictly between a and b?
function clearBetween(x: number, a: number, b: number, geo: RowGeometry): boolean {
  for (let r = Math.min(a, b) + 1; r < Math.max(a, b); r++) {
    const bar = geo.bars[r]
    if (bar && x >= bar[0] - CLEARANCE && x <= bar[1] + CLEARANCE) return false
  }
  return true
}

function mid(row: number, geo: RowGeometry): number {
  return row * geo.rowHeight + geo.rowHeight / 2
}

// Drop points that do not change direction, so each segment is maximal.
function simplify(points: Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && last[0] === p[0] && last[1] === p[1]) continue
    const prev = out[out.length - 2]
    if (prev && last && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) {
      out[out.length - 1] = p
    } else {
      out.push(p)
    }
  }
  return out
}

export interface RouteOptions {
  stubOut?: number
  stubIn?: number
  // Vertical x positions already used by other connectors; avoided when possible.
  takenX?: number[] | TakenX
  // Offsets from the bar's centre line where the connector leaves / arrives,
  // so several connectors on one edge of a bar stay apart.
  yOut?: number
  yIn?: number
}

// Candidate x positions for the vertical run between rows a and b: near the
// preferred positions, and just past either side of every bar in between.
function candidates(preferred: number[], a: number, b: number, geo: RowGeometry): number[] {
  const out = preferred.flatMap((x) => [x, x - LANE, x + LANE, x - 2 * LANE, x + 2 * LANE])
  for (let r = Math.min(a, b) + 1; r < Math.max(a, b); r++) {
    const bar = geo.bars[r]
    if (bar) out.push(bar[0] - CLEARANCE - 1, bar[1] + CLEARANCE + 1)
  }
  return out
}

function pick(
  xs: number[],
  ok: (x: number) => boolean,
  cost: (x: number) => number,
  taken: TakenX,
): number | null {
  let best: number | null = null
  let bestCost = Number.POSITIVE_INFINITY
  for (const x of xs) {
    if (!ok(x)) continue
    // A vertical already used by another connector costs extra, so lanes stay apart.
    const c = cost(x) + (taken.near(x) ? 1_000 : 0)
    if (c < bestCost) {
      best = x
      bestCost = c
    }
  }
  return best
}

export function routeConnector(edge: ConnectorEdge, geo: RowGeometry, opts: RouteOptions = {}): Point[] {
  const from = geo.bars[edge.fromRow]
  const to = geo.bars[edge.toRow]
  if (!from || !to || edge.fromRow === edge.toRow) return []
  const stubOut = opts.stubOut ?? STUB
  const stubIn = opts.stubIn ?? STUB
  const taken = opts.takenX instanceof TakenX ? opts.takenX : TakenX.from(opts.takenX ?? [])
  const fromX = from[1]
  const toX = to[0]
  const yA = mid(edge.fromRow, geo) + (opts.yOut ?? 0)
  const yB = mid(edge.toRow, geo) + (opts.yIn ?? 0)

  // Gap path: one vertical run between the two bars.
  const lo = fromX + stubOut
  const hi = toX - stubIn
  if (hi >= lo) {
    const inRange = (x: number) => x >= lo && x <= hi && clearBetween(x, edge.fromRow, edge.toRow, geo)
    const x = pick(candidates([hi, lo], edge.fromRow, edge.toRow, geo), inRange, () => 0, taken)
    if (x !== null) return simplify([[fromX, yA], [x, yA], [x, yB], [toX, yB]])
  }

  // Path along the gaps between rows.
  const down = edge.toRow > edge.fromRow
  const boundaryA = (down ? edge.fromRow + 1 : edge.fromRow) * geo.rowHeight
  const boundaryB = (down ? edge.toRow : edge.toRow + 1) * geo.rowHeight
  // Step the exit right / the entry left off verticals other connectors use;
  // either way it stays beside its own bar.
  const isTaken = (x: number) => taken.near(x)
  let exitX = fromX + stubOut
  while (isTaken(exitX)) exitX += LANE
  let entryX = toX - stubIn
  while (isTaken(entryX)) entryX -= LANE
  if (boundaryA === boundaryB) {
    return simplify([
      [fromX, yA],
      [exitX, yA],
      [exitX, boundaryA],
      [entryX, boundaryA],
      [entryX, yB],
      [toX, yB],
    ])
  }
  // The vertical run crosses every line strictly between the two bars.
  const clear = (x: number) => clearBetween(x, edge.fromRow, edge.toRow, geo)
  let leftmost = Math.min(exitX, entryX)
  for (let r = Math.min(edge.fromRow, edge.toRow) + 1; r < Math.max(edge.fromRow, edge.toRow); r++) {
    const bar = geo.bars[r]
    if (bar) leftmost = Math.min(leftmost, bar[0] - CLEARANCE - 1)
  }
  const xv =
    pick(
      candidates([exitX, entryX, leftmost], edge.fromRow, edge.toRow, geo),
      clear,
      (x) => Math.abs(x - exitX) + Math.abs(x - entryX),
      taken,
    ) ?? leftmost
  return simplify([
    [fromX, yA],
    [exitX, yA],
    [exitX, boundaryA],
    [xv, boundaryA],
    [xv, boundaryB],
    [entryX, boundaryB],
    [entryX, yB],
    [toX, yB],
  ])
}

// Offsets 0, -d, +d, -2d, +2d, ... capped at ±max (cycles once exhausted).
function laneOffset(rank: number, step: number, max: number): number {
  const slots = [0]
  for (let k = step; k <= max; k += step) slots.push(-k, k)
  const i = rank % slots.length
  return slots[i]
}

const EDGE_SPREAD = 3 // vertical spacing of connectors on one bar edge (bar is 14px tall)
const EDGE_MAX = 6
const BOUNDARY_MAX = 6 // a row boundary has 7px of free space on each side

type Segment = { a: Point; b: Point; path: number }

function horizontalOnBoundary(p: Point, q: Point, rowHeight: number): boolean {
  return p[1] === q[1] && p[1] % rowHeight === 0
}

// Routes every edge, giving connectors that share a bar edge, a vertical x or
// a stretch of row boundary their own lane.
export function routeConnectors(edges: ConnectorEdge[], geo: RowGeometry): Point[][] {
  const outRank = new Map<number, number>()
  const inRank = new Map<number, number>()
  const order = edges.map((e, i) => ({ e, i })).sort((p, q) => p.e.toRow - q.e.toRow || p.e.fromRow - q.e.fromRow)
  const ranks = new Map<number, { out: number; in: number }>()
  for (const { e, i } of order) {
    const o = outRank.get(e.fromRow) ?? 0
    const n = inRank.get(e.toRow) ?? 0
    outRank.set(e.fromRow, o + 1)
    inRank.set(e.toRow, n + 1)
    ranks.set(i, { out: o, in: n })
  }
  const takenX = new TakenX()
  const paths = edges.map((edge, i) => {
    const r = ranks.get(i)!
    const path = routeConnector(edge, geo, {
      stubOut: STUB + LANE * r.out,
      stubIn: STUB + LANE * r.in,
      yOut: laneOffset(r.out, EDGE_SPREAD, EDGE_MAX),
      yIn: laneOffset(r.in, EDGE_SPREAD, EDGE_MAX),
      takenX,
    })
    for (let k = 0; k + 1 < path.length; k++) {
      if (path[k][0] === path[k + 1][0]) takenX.add(path[k][0])
    }
    return path
  })

  // Overlapping runs along the same row boundary move to separate lanes.
  const byY = new Map<number, Array<{ path: number; k: number; lo: number; hi: number }>>()
  paths.forEach((path, p) => {
    for (let k = 0; k + 1 < path.length; k++) {
      const [a, b] = [path[k], path[k + 1]]
      if (!horizontalOnBoundary(a, b, geo.rowHeight)) continue
      const list = byY.get(a[1]) ?? []
      list.push({ path: p, k, lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) })
      byY.set(a[1], list)
    }
  })
  for (const [y, runs] of byY) {
    const placed: Array<{ lo: number; hi: number; offset: number }> = []
    for (const run of runs) {
      let lane = 0
      while (placed.some((q) => q.offset === laneOffset(lane, LANE / 2 + 1, BOUNDARY_MAX) && q.lo < run.hi && run.lo < q.hi)) lane++
      const offset = laneOffset(lane, LANE / 2 + 1, BOUNDARY_MAX)
      placed.push({ lo: run.lo, hi: run.hi, offset })
      if (offset !== 0) {
        paths[run.path][run.k] = [paths[run.path][run.k][0], y + offset]
        paths[run.path][run.k + 1] = [paths[run.path][run.k + 1][0], y + offset]
      }
    }
  }
  return paths
}

// Pairs of connectors that share a stretch of the same line (for tests and
// debugging; crossing at a single point is fine).
export function sharedSegments(paths: Point[][]): Array<[number, number]> {
  const segs: Segment[] = []
  paths.forEach((path, p) => {
    for (let k = 0; k + 1 < path.length; k++) segs.push({ a: path[k], b: path[k + 1], path: p })
  })
  const out: Array<[number, number]> = []
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [s, t] = [segs[i], segs[j]]
      if (s.path === t.path) continue
      const horizontal = s.a[1] === s.b[1] && t.a[1] === t.b[1] && s.a[1] === t.a[1]
      const vertical = s.a[0] === s.b[0] && t.a[0] === t.b[0] && s.a[0] === t.a[0]
      if (!horizontal && !vertical) continue
      const along = (p: Point) => (horizontal ? p[0] : p[1])
      const overlap =
        Math.min(Math.max(along(s.a), along(s.b)), Math.max(along(t.a), along(t.b))) -
        Math.max(Math.min(along(s.a), along(s.b)), Math.min(along(t.a), along(t.b)))
      if (overlap > 0) out.push([s.path, t.path])
    }
  }
  return out
}
