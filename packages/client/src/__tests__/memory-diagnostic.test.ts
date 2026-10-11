// beadbox-bez: the page's memory diagnostic sends COUNTS ONLY, on a 60 s then
// 5 min cadence, with one timer per page lifetime.

import { afterEach, expect, test } from "bun:test"
import {
  collectSample,
  MEMORY_SAMPLE_FIRST_MS,
  MEMORY_SAMPLE_INTERVAL_MS,
  type MemorySample,
  type MemorySources,
  sessionTreeCounts,
  startMemoryDiagnostic,
} from "../lib/memory-diagnostic"
import type { Epic } from "../lib/types"
import {
  _resetWorkspaceSessions,
  createWorkspaceSessionCache,
  sessionEpics,
} from "../lib/workspace-session-cache"

const SENTINELS = [
  "SENTINEL-TITLE-bez",
  "sentinel description text",
  "/Users/sentinel/secret-project/.beads",
]
const [TITLE, DESC, PATH] = SENTINELS

/** Fixture caches whose contents are full of sentinel text. */
function hostileSources(): MemorySources {
  const bead = { id: "sx-1", title: TITLE, description: DESC, path: PATH }
  const activity = createWorkspaceSessionCache<unknown[]>()
  activity.set(PATH, [{ title: TITLE, actor: DESC }, { title: TITLE }])
  activity.set(`${PATH}-2`, [{ title: TITLE }])
  const epics = createWorkspaceSessionCache<unknown[]>()
  epics.set(PATH, [bead])
  return {
    queries: () => [
      { state: { data: [bead, bead, bead] } },
      { state: { data: { title: TITLE, workspace: PATH } } },
      { state: { data: undefined } },
    ],
    epics: () => ({ epics: 2, beads: 7 }),
    detail: () => 4,
    listeners: () => 2,
    pathname: () => `/chart/${TITLE}`,
    activity: () => activity.stats().items,
    sessionWorkspaces: () => epics.stats().entries,
  }
}

test("a sample of sentinel-filled caches holds counts only", () => {
  const sample = collectSample(hostileSources(), "ab12cd34", 0, 61.4)
  const json = JSON.stringify(sample)
  for (const s of SENTINELS) expect(json).not.toContain(s)
  expect(sample).toEqual({
    page: "ab12cd34",
    seq: 0,
    up_s: 61,
    q: 3,
    q_rows: 3,
    epics: 2,
    epic_beads: 7,
    detail: 4,
    activity: 3,
    session_ws: 1,
    listeners: 2,
    // An unknown path (here one carrying a title) is "other", never echoed.
    view: "other",
  })
  // Every value but the two fixed-shape tokens is a number.
  for (const [k, v] of Object.entries(sample))
    if (k !== "page" && k !== "view") expect(typeof v).toBe("number")
})

test("known routes map to their fixed view ids", () => {
  const sources = { ...hostileSources(), pathname: () => "/activity" }
  expect(collectSample(sources, "ab12cd34", 0, 0).view).toBe("activity")
})

/** A fake clock: timers fire only when the test advances time. */
function fakeTimers() {
  let t = 0
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++
      pending.set(id, { at: t + ms, fn })
      return id
    },
    clearTimer: (id: unknown) => {
      pending.delete(id as number)
    },
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, p]) => p.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        t = due[1].at
        due[1].fn()
        await Promise.resolve()
      }
      t = end
    },
    pending: () => pending.size,
  }
}

let stopCurrent: (() => void) | null = null
afterEach(() => {
  stopCurrent?.()
  stopCurrent = null
})

function start(clock: ReturnType<typeof fakeTimers>, enabled = true) {
  const sent: MemorySample[] = []
  stopCurrent = startMemoryDiagnostic({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sources: hostileSources(),
    send: async (s) => {
      sent.push(s)
      return { enabled }
    },
  })
  return sent
}

test("first sample at 60 s, then every 5 min, seq counting up on one page id", async () => {
  const clock = fakeTimers()
  const sent = start(clock)
  await clock.advance(MEMORY_SAMPLE_FIRST_MS - 1)
  expect(sent).toHaveLength(0)
  await clock.advance(1)
  expect(sent).toHaveLength(1)
  await clock.advance(MEMORY_SAMPLE_INTERVAL_MS * 3)
  expect(sent.map((s) => s.seq)).toEqual([0, 1, 2, 3])
  expect(new Set(sent.map((s) => s.page)).size).toBe(1)
  expect(sent[0].page).toMatch(/^[0-9a-f]{8}$/)
  expect(clock.pending()).toBe(1)
})

test("a second start is a no-op: still one timer", async () => {
  const clock = fakeTimers()
  const sent = start(clock)
  const again = startMemoryDiagnostic({ now: clock.now, setTimer: clock.setTimer })
  expect(again).toBe(stopCurrent as () => void)
  expect(clock.pending()).toBe(1)
  await clock.advance(MEMORY_SAMPLE_FIRST_MS + MEMORY_SAMPLE_INTERVAL_MS)
  expect(sent).toHaveLength(2)
})

test("stop() ends it: no more samples and no timer left", async () => {
  const clock = fakeTimers()
  const sent = start(clock)
  await clock.advance(MEMORY_SAMPLE_FIRST_MS)
  stopCurrent?.()
  await clock.advance(MEMORY_SAMPLE_INTERVAL_MS * 4)
  expect(sent).toHaveLength(1)
  expect(clock.pending()).toBe(0)
})

test("the sidecar's off-switch (enabled:false) stops the timer", async () => {
  const clock = fakeTimers()
  const sent = start(clock, false)
  await clock.advance(MEMORY_SAMPLE_FIRST_MS)
  await Promise.resolve()
  await clock.advance(MEMORY_SAMPLE_INTERVAL_MS * 4)
  expect(sent).toHaveLength(1)
  expect(clock.pending()).toBe(0)
})

test("session cache stats count entries and array items, nothing else", () => {
  const cache = createWorkspaceSessionCache<unknown>(10)
  expect(cache.stats()).toEqual({ entries: 0, items: 0 })
  cache.set("a", [1, 2, 3])
  cache.set("b", { not: "an array" })
  expect(cache.stats()).toEqual({ entries: 2, items: 4 })
})

test("epic counts come from the tree the Beads view renders (sessionEpics)", () => {
  // The Beads view caches its tree per workspace in sessionEpics; the older
  // epic-cache tree is never filled in production, so counting it read 0
  // while beads were being written (caught on .207).
  _resetWorkspaceSessions()
  try {
    expect(sessionTreeCounts()).toEqual({ epics: 0, beads: 0 })
    const bead = (id: string, children: unknown[] = []) => ({ id, title: TITLE, children })
    const tree = [
      {
        ...bead("e1", [bead("b1", [bead("b1a")]), bead("b2")]),
        childEpics: [bead("e2", [bead("b3")])],
      },
      bead("e3"),
    ] as unknown as Epic[]
    sessionEpics.set(PATH, tree)
    sessionEpics.set(`${PATH}-2`, [bead("e4", [bead("b4")])] as unknown as Epic[])
    // e1, e2, e3, e4 / b1, b1a, b2, b3, b4
    const counts = sessionTreeCounts()
    expect(counts).toEqual({ epics: 4, beads: 5 })
    expect(JSON.stringify(counts)).not.toContain(TITLE)
  } finally {
    _resetWorkspaceSessions()
  }
})
