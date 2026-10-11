// beadbox-bez: a memory diagnostic for the page. Every few minutes the page
// sends a sample of COUNTS (cache sizes, feed length, view) and this handler
// writes one line to stderr, which the log-file tee copies into the sidecar
// log. The next time the page climbs toward WebKit's memory limit, the log
// shows what grew.
//
// The line holds counts only. The page already sends only numbers, but the
// formatter does not trust that: a known field that is not a finite integer
// >= 0 prints "?", the page id must be 8 hex digits, the view must be one of
// the app's routes, and unknown fields are dropped. No title, path or env
// value can reach the log through here.
//
// Off-switch: BEADBOX_MEMORY_LOG=0 writes nothing and answers enabled:false,
// so the page stops its timer.

import { formatMemoryLine, type MemorySample, writeMemoryLine } from "./memory-internals"
import { state } from "./subscribe-internals"

export type { MemorySample }

export async function record(sample: MemorySample): Promise<{ enabled: boolean }> {
  if (process.env.BEADBOX_MEMORY_LOG === "0") return { enabled: false }
  writeMemoryLine(
    formatMemoryLine(sample ?? {}, {
      subs: state.detectors.size,
      sidecar_rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    }),
  )
  return { enabled: true }
}
