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
  // Vertical positions other connectors use, per line they run through; a
  // staircase crossing there would share a segment (beadbox-a0p, design D2).
  takenByRow?: Map<number, TakenX>
  // Horizontal runs other connectors make along each row boundary (keyed by
  // the boundary's y), so a staircase can avoid crowding one (design D2b).
  boundaryRuns?: Map<number, Array<[number, number]>>
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
    // Only a free position: when every clear one is taken, the staircase below
    // steps around instead of sharing a segment.
    const inRange = (x: number) =>
      x >= lo && x <= hi && clearBetween(x, edge.fromRow, edge.toRow, geo) && !taken.near(x)
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
  // Staircase (beadbox-a0p, design D1): cross the lines between the two bars
  // one at a time, each where that line has no bar, moving sideways in the
  // gaps between lines. A lone vertical run clear of every line is only the
  // special case with no sideways step.
  const steps = staircase(
    edge,
    geo,
    exitX,
    entryX,
    (row, x) => (opts.takenByRow?.get(row)?.near(x) ? SHARED_COST : 0),
    (y, lo, hi) => crowdCost(opts.boundaryRuns?.get(y), lo, hi),
  )
  const points: Point[] = [[fromX, yA], [exitX, yA], [exitX, boundaryA]]
  for (const { x, from: y0, to: y1 } of steps) points.push([x, y0], [x, y1])
  points.push([entryX, boundaryB], [entryX, yB], [toX, yB])
  return simplify(points)
}

const BEND = 24 // cost of one bend, in px of path length: keeps staircases to few steps
// Crossing a line where another connector already runs. Far above a sidestep
// (a few px plus two bends), so sharing is never preferred (design D2).
const SHARED_COST = 1_000
// A row boundary has 7px of free space on each side: lanes at 0, ±3, ±6.
const LANE_CAPACITY = 5
// Per run already on a boundary over the same stretch: spreads routes over
// neighbouring boundaries before one fills up (design D2b).
const CROWD_COST = 8

function crowdCost(runs: Array<[number, number]> | undefined, lo: number, hi: number): number {
  if (!runs) return 0
  let overlapping = 0
  for (const [a, b] of runs) if (a < hi && lo < b) overlapping++
  return overlapping >= LANE_CAPACITY ? SHARED_COST : overlapping * CROWD_COST
}

// Is x clear of the bar in one line?
function clearOf(x: number, row: number, geo: RowGeometry): boolean {
  const bar = geo.bars[row]
  return !bar || x < bar[0] - CLEARANCE || x > bar[1] + CLEARANCE
}

// Dynamic programming over the boundaries between the lines strictly between
// the two bars, from the source side to the target side. Returns, per crossed
// line, the x where it is crossed and the boundary ys it runs between.
function staircase(
  edge: ConnectorEdge,
  geo: RowGeometry,
  exitX: number,
  entryX: number,
  crossCost: (row: number, x: number) => number,
  runCost: (boundaryY: number, lo: number, hi: number) => number,
): Array<{ x: number; from: number; to: number }> {
  const down = edge.toRow > edge.fromRow
  const rows: number[] = []
  for (let r = edge.fromRow + (down ? 1 : -1); r !== edge.toRow; r += down ? 1 : -1) rows.push(r)
  if (rows.length === 0) return []
  const boundary = (i: number) => (down ? edge.fromRow + 1 + i : edge.fromRow - i) * geo.rowHeight

  const seeds = [exitX, entryX]
  for (const r of rows) {
    const bar = geo.bars[r]
    if (bar) seeds.push(bar[0] - CLEARANCE - 1, bar[1] + CLEARANCE + 1)
  }
  const xs = [...new Set(seeds.flatMap((x) => [x, x - LANE, x + LANE, x - 2 * LANE, x + 2 * LANE]))]
  const move = (a: number, b: number, y: number) =>
    a === b ? 0 : Math.abs(a - b) + 2 * BEND + runCost(y, Math.min(a, b), Math.max(a, b))

  // arrive[j]: cheapest cost to stand at xs[j] on the current boundary.
  let arrive = xs.map((x) => (x === exitX ? 0 : Number.POSITIVE_INFINITY))
  const choice: number[][] = [] // per crossed line: chosen xs index for each arrival index
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const next = xs.map(() => Number.POSITIVE_INFINITY)
    const via = xs.map(() => -1)
    for (let to = 0; to < xs.length; to++) {
      if (!clearOf(xs[to], row, geo)) continue
      // Best way to reach xs[to] along this boundary, then cross the line there.
      let best = Number.POSITIVE_INFINITY
      let bestFrom = -1
      for (let from = 0; from < xs.length; from++) {
        if (!Number.isFinite(arrive[from])) continue
        const c = arrive[from] + move(xs[from], xs[to], boundary(i))
        if (c < best) {
          best = c
          bestFrom = from
        }
      }
      if (bestFrom < 0) continue
      next[to] = best + geo.rowHeight + crossCost(row, xs[to])
      via[to] = bestFrom
    }
    choice.push(via)
    arrive = next
  }

  // Finish: along the last boundary to entryX.
  let end = -1
  let endCost = Number.POSITIVE_INFINITY
  for (let j = 0; j < xs.length; j++) {
    const c = arrive[j] + move(xs[j], entryX, boundary(rows.length))
    if (c < endCost) {
      endCost = c
      end = j
    }
  }
  // Every line has free space beside its bar, so a route always exists.
  const crossings: number[] = []
  for (let i = rows.length - 1, j = end; i >= 0; i--) {
    crossings.unshift(j)
    j = choice[i][j]
  }
  return crossings.map((j, i) => ({ x: xs[j], from: boundary(i), to: boundary(i + 1) }))
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
  const takenByRow = new Map<number, TakenX>()
  const boundaryRuns = new Map<number, Array<[number, number]>>()
  // A vertical ending on a boundary also claims the lane margin past it: the
  // post-pass below may shift a neighbour's run along that boundary by up to
  // BOUNDARY_MAX, which would otherwise stretch its vertical into this one.
  const occupy = (x: number, y0: number, y1: number) => {
    const [top, bottom] = [Math.min(y0, y1) - BOUNDARY_MAX, Math.max(y0, y1) + BOUNDARY_MAX]
    for (let row = Math.floor(top / geo.rowHeight); row * geo.rowHeight < bottom; row++) {
      let lane = takenByRow.get(row)
      if (!lane) {
        lane = new TakenX()
        takenByRow.set(row, lane)
      }
      lane.add(x)
    }
  }
  const paths = edges.map((edge, i) => {
    const r = ranks.get(i)!
    const path = routeConnector(edge, geo, {
      stubOut: STUB + LANE * r.out,
      stubIn: STUB + LANE * r.in,
      yOut: laneOffset(r.out, EDGE_SPREAD, EDGE_MAX),
      yIn: laneOffset(r.in, EDGE_SPREAD, EDGE_MAX),
      takenX,
      takenByRow,
      boundaryRuns,
    })
    for (let k = 0; k + 1 < path.length; k++) {
      const [a, b] = [path[k], path[k + 1]]
      if (horizontalOnBoundary(a, b, geo.rowHeight)) {
        const runs = boundaryRuns.get(a[1]) ?? []
        runs.push([Math.min(a[0], b[0]), Math.max(a[0], b[0])])
        boundaryRuns.set(a[1], runs)
      }
      if (path[k][0] !== path[k + 1][0]) continue
      takenX.add(path[k][0])
      occupy(path[k][0], path[k][1], path[k + 1][1])
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
      // The first free lane; with all LANE_CAPACITY taken over this stretch,
      // the least crowded one. (An unbounded search never ended once six
      // runs overlapped: laneOffset wraps around, design D2b.)
      let offset = laneOffset(0, LANE / 2 + 1, BOUNDARY_MAX)
      let fewest = Number.POSITIVE_INFINITY
      for (let lane = 0; lane < LANE_CAPACITY; lane++) {
        const candidate = laneOffset(lane, LANE / 2 + 1, BOUNDARY_MAX)
        const overlaps = placed.filter((q) => q.offset === candidate && q.lo < run.hi && run.lo < q.hi).length
        if (overlaps < fewest) {
          fewest = overlaps
          offset = candidate
        }
        if (overlaps === 0) break
      }
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
