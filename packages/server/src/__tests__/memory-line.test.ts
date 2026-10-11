// beadbox-bez: the memory diagnostic line holds COUNTS ONLY. Whatever the page
// sends, the sidecar formatter lets through numbers and two fixed-shape tokens
// (an 8-hex page id, a view from an allowlist); titles, paths and env never
// reach the log.

import { afterEach, expect, test } from "bun:test"
import { record } from "../handlers/memory"
import { _resetWriter, _setWriter, formatMemoryLine } from "../handlers/memory-internals"

const SENTINELS = [
  "SENTINEL-TITLE-bez",
  "/Users/sentinel/secret-project/.beads",
  "BEADS_DOLT_PASSWORD=sentinel",
  "sentinel description text",
]

afterEach(() => {
  _resetWriter()
  delete process.env.BEADBOX_MEMORY_LOG
})

const extras = { subs: 1, sidecar_rss_mb: 88 }

test("a well-formed sample becomes one counts-only line", () => {
  const line = formatMemoryLine(
    {
      page: "ab12cd34",
      seq: 3,
      up_s: 960,
      q: 12,
      q_rows: 340,
      epics: 4,
      epic_beads: 210,
      detail: 17,
      activity: 500,
      session_ws: 3,
      listeners: 2,
      view: "chart",
    },
    extras,
  )
  expect(line).toBe(
    "[memory] page=ab12cd34 seq=3 up_s=960 mem=n/a q=12 q_rows=340 epics=4 epic_beads=210 detail=17 activity=500 session_ws=3 listeners=2 view=chart subs=1 sidecar_rss_mb=88",
  )
})

test("no sentinel text in any field (or an unknown field) reaches the line", () => {
  const [t, p, e, d] = SENTINELS
  const hostile = {
    page: t,
    seq: p,
    up_s: e,
    q: d,
    q_rows: [t],
    epics: { title: t },
    epic_beads: Number.NaN,
    detail: -1,
    activity: 1.5,
    session_ws: "1",
    listeners: Number.POSITIVE_INFINITY,
    view: p,
    title: t,
    path: p,
    env: e,
  } as unknown as Parameters<typeof formatMemoryLine>[0]
  const line = formatMemoryLine(hostile, extras)
  for (const s of SENTINELS) expect(line).not.toContain(s)
  expect(line).toBe(
    "[memory] page=? seq=? up_s=? mem=n/a q=? q_rows=? epics=? epic_beads=? detail=? activity=? session_ws=? listeners=? view=other subs=1 sidecar_rss_mb=88",
  )
})

test("record() writes exactly one line per sample", async () => {
  const lines: string[] = []
  _setWriter((l) => lines.push(l))
  expect(await record({ page: "0123abcd", seq: 0, up_s: 60, view: "index" })).toEqual({
    enabled: true,
  })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toStartWith("[memory] page=0123abcd seq=0 up_s=60 mem=n/a")
})

test("off-switch: BEADBOX_MEMORY_LOG=0 writes nothing and tells the page to stop", async () => {
  const lines: string[] = []
  _setWriter((l) => lines.push(l))
  process.env.BEADBOX_MEMORY_LOG = "0"
  expect(await record({ page: "0123abcd", seq: 0 })).toEqual({ enabled: false })
  expect(lines).toHaveLength(0)
})
