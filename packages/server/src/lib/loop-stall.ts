// Says so in the log when this process's own event loop stalled (beadbox-0b6).
//
// Two nights' bd calls logged 45.03 s against a 30 s exec timeout. Timers firing
// late would explain it and no measurement has shown it, so the next time it
// happens the log answers the question: a tick that arrives much later than its
// time means nothing on this thread ran in between. It only logs; nothing acts
// on it. If the timer itself is gated the line comes late, and its size says so.

const TICK_MS = 5_000
const REPORT_OVER_MS = 5_000

/** The stall to report for a tick seen at `at`, or null. */
export function stallMs(
  lastTickAt: number,
  at: number,
  tickMs = TICK_MS,
  reportOverMs = REPORT_OVER_MS,
): number | null {
  const late = at - lastTickAt - tickMs
  return late > reportOverMs ? late : null
}

export function startLoopStallLog(now: () => number = Date.now): () => void {
  let lastTickAt = now()
  const timer = setInterval(() => {
    const at = now()
    const late = stallMs(lastTickAt, at)
    lastTickAt = at
    if (late !== null) console.error(`[sidecar] event loop stalled: tick ${late}ms late at ${new Date(at).toISOString()}`)
  }, TICK_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
