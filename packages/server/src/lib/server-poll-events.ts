import type { SubscriptionEvent } from "../subscribe-protocol"

export function createPollEvents() {
  let last: string | null = null
  let errors = 0

  return {
    success(result: string): SubscriptionEvent[] {
      const events: SubscriptionEvent[] = []
      if (errors >= 3) events.push({ type: "recovered" })
      errors = 0
      if (last !== null && last !== result) {
        events.push({ type: "change", timestamp: Date.now() })
      }
      last = result
      return events
    },
    failure(retryMs: number): SubscriptionEvent[] {
      errors++
      if (errors === 3) return [{ type: "polling_error" }]
      if (errors > 3) {
        return [{ type: "reconnecting", attempt_number: errors, backoff_ms: retryMs }]
      }
      return []
    },
  }
}
