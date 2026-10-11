// beadbox-bez: the memory line's formatter and writer seam. They live here,
// not in handlers/memory.ts, because every export of a handler module is an
// RPC method the webview can call; the public surface is only memory.record.

export interface MemorySample {
  page?: string
  seq?: number
  up_s?: number
  q?: number
  q_rows?: number
  epics?: number
  epic_beads?: number
  detail?: number
  activity?: number
  session_ws?: number
  listeners?: number
  view?: string
}

const COUNT_FIELDS = [
  "q",
  "q_rows",
  "epics",
  "epic_beads",
  "detail",
  "activity",
  "session_ws",
  "listeners",
] as const

export const MEMORY_VIEWS = [
  "index",
  "activity",
  "chart",
  "formulas",
  "trains",
  "workspaces",
] as const

function count(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : "?"
}

export function formatMemoryLine(
  sample: MemorySample,
  extras: { subs: number; sidecar_rss_mb: number },
): string {
  const page =
    typeof sample.page === "string" && /^[0-9a-f]{8}$/.test(sample.page) ? sample.page : "?"
  const view = (MEMORY_VIEWS as readonly string[]).includes(sample.view as string)
    ? (sample.view as string)
    : "other"
  const parts = [
    `page=${page}`,
    `seq=${count(sample.seq)}`,
    `up_s=${count(sample.up_s)}`,
    // WebKit gives the page no memory API; the WebContent footprint is in the
    // unified log under the host pid (systemdesign §5.2).
    "mem=n/a",
    ...COUNT_FIELDS.map((f) => `${f}=${count(sample[f])}`),
    `view=${view}`,
    `subs=${count(extras.subs)}`,
    `sidecar_rss_mb=${count(extras.sidecar_rss_mb)}`,
  ]
  return `[memory] ${parts.join(" ")}`
}

const defaultWriter = (line: string): void => {
  console.error(line)
}
let writer: (line: string) => void = defaultWriter

/** Test seam. */
export function _setWriter(fn: (line: string) => void): void {
  writer = fn
}
export function _resetWriter(): void {
  writer = defaultWriter
}

export function writeMemoryLine(line: string): void {
  writer(line)
}
