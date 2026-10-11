// beadbox-bez: a memory diagnostic. Every 5 minutes the page sends the sidecar
// COUNTS of its main in-memory structures, and the sidecar writes one line to
// its log (packages/server/src/handlers/memory.ts). WebKit killed a page at a
// 3.2 GB JavaScript heap (beadbox-005) and synthetic sessions don't reproduce
// it, so the next real climb has to show in the log what grew.
//
// Counts only: the sample holds numbers, plus a per-page-lifetime id and the
// view (a fixed route id). The sidecar enforces the same again. WebKit has no
// page-memory API, so the memory figure is "n/a" here; WebKit's own footprint
// lines are in the unified log under the host pid.
//
// A new page lifetime (app start, or a reload after WebKit killed the page,
// beadbox-z04) gets a new page id and restarts seq at 0.

import { getBeadDetailCacheStats } from "./epic-cache"
import { queryClient } from "./query-client"
import { rpc } from "./rpc"
import { getSubscriptionListenerCount } from "./subscribe"
import type { Bead, Epic } from "./types"
import { sessionActivityEvents, sessionEpics } from "./workspace-session-cache"

export const MEMORY_SAMPLE_FIRST_MS = 60_000
export const MEMORY_SAMPLE_INTERVAL_MS = 5 * 60_000

const VIEWS: Record<string, string> = {
  "/": "index",
  "/activity": "activity",
  "/chart": "chart",
  "/formulas": "formulas",
  "/trains": "trains",
  "/workspaces": "workspaces",
}

export interface MemorySample {
  page: string
  seq: number
  up_s: number
  q: number
  q_rows: number
  epics: number
  epic_beads: number
  detail: number
  activity: number
  session_ws: number
  listeners: number
  view: string
}

export interface MemorySources {
  queries: () => ReadonlyArray<{ state: { data: unknown } }>
  epics: () => { epics: number; beads: number }
  detail: () => number
  listeners: () => number
  pathname: () => string
  /** Activity events held across workspaces (the session cache). */
  activity: () => number
  /** Workspaces held in the per-workspace session cache. */
  sessionWorkspaces: () => number
}

/**
 * Epics and beads held in the per-workspace tree cache (sessionEpics), which
 * is what the Beads view renders from. Counts only: the walk reads lengths.
 */
export function sessionTreeCounts(): { epics: number; beads: number } {
  let epics = 0
  let beads = 0
  const walkBeads = (list: Bead[] | undefined): void => {
    for (const bead of list ?? []) {
      beads++
      walkBeads(bead.children)
    }
  }
  const walkEpics = (list: Epic[] | undefined): void => {
    for (const epic of list ?? []) {
      epics++
      walkBeads(epic.children)
      walkEpics(epic.childEpics)
    }
  }
  sessionEpics.sumOver((tree) => {
    walkEpics(tree)
    return 0
  })
  return { epics, beads }
}

const defaultSources: MemorySources = {
  queries: () => queryClient.getQueryCache().getAll(),
  epics: sessionTreeCounts,
  detail: () => getBeadDetailCacheStats().size,
  listeners: getSubscriptionListenerCount,
  pathname: () => "",
  activity: () => sessionActivityEvents.stats().items,
  sessionWorkspaces: () => sessionEpics.stats().entries,
}

function nonNegativeInt(n: number): number {
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

export function viewOf(pathname: string): string {
  return VIEWS[pathname] ?? "other"
}

export function collectSample(
  sources: MemorySources,
  page: string,
  seq: number,
  upSeconds: number,
): MemorySample {
  const queries = sources.queries()
  let rows = 0
  for (const q of queries) if (Array.isArray(q.state.data)) rows += q.state.data.length
  const epics = sources.epics()
  return {
    page,
    seq,
    up_s: nonNegativeInt(Math.round(upSeconds)),
    q: queries.length,
    q_rows: rows,
    epics: nonNegativeInt(epics.epics),
    epic_beads: nonNegativeInt(epics.beads),
    detail: nonNegativeInt(sources.detail()),
    activity: nonNegativeInt(sources.activity()),
    session_ws: nonNegativeInt(sources.sessionWorkspaces()),
    listeners: nonNegativeInt(sources.listeners()),
    view: viewOf(sources.pathname()),
  }
}

function newPageId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

interface StartOptions {
  getPathname?: () => string
  send?: (sample: MemorySample) => Promise<{ enabled: boolean }>
  sources?: Partial<MemorySources>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

let running: (() => void) | null = null

/**
 * Starts the diagnostic for this page lifetime. Idempotent: a second call
 * returns the running instance's stop function instead of adding a timer.
 */
export function startMemoryDiagnostic(options: StartOptions = {}): () => void {
  if (running) return running
  const sources: MemorySources = {
    ...defaultSources,
    ...(options.getPathname ? { pathname: options.getPathname } : {}),
    ...options.sources,
  }
  const send = options.send ?? ((sample: MemorySample) => rpc.memory.record(sample))
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const page = newPageId()
  const started = now()
  let seq = 0
  let handle: unknown = null
  let stopped = false

  const stop = (): void => {
    stopped = true
    if (handle !== null) clearTimer(handle)
    handle = null
    if (running === stop) running = null
  }

  const tick = (): void => {
    handle = null
    if (stopped) return
    const sample = collectSample(sources, page, seq++, (now() - started) / 1000)
    send(sample)
      .then((result) => {
        if (result && result.enabled === false) stop()
      })
      .catch(() => {
        // A failed write (sidecar restarting) skips one sample; the next one
        // still comes.
      })
    if (!stopped) handle = setTimer(tick, MEMORY_SAMPLE_INTERVAL_MS)
  }

  handle = setTimer(tick, MEMORY_SAMPLE_FIRST_MS)
  running = stop
  return stop
}
