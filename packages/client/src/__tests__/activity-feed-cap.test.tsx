// The Activity feed prepends each change's new events to its list (and mirrors
// the list into the per-workspace session cache), so a feed left open on a
// busy workspace grew without bound (beadbox-005). The list is capped at the
// newest MAX_FEED_EVENTS; older ones stay reachable through "load more".

import { afterEach, expect, mock, test } from "bun:test"
import { act, cleanup, render, waitFor } from "@testing-library/react"

import { ActivityFeed, MAX_FEED_EVENTS } from "../components/activity-feed"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { ActivityEvent } from "../lib/types"
import { _resetWorkspaceSessions, sessionActivityEvents } from "../lib/workspace-session-cache"

let issued = 0
const event = (): ActivityEvent => {
  issued++
  return {
    timestamp: new Date(Date.UTC(2026, 9, 10, 0, 0, issued)).toISOString(),
    type: "update",
    issue_id: `cap-${issued}`,
    symbol: "~",
    message: `event ${issued}`,
  }
}

afterEach(() => {
  cleanup()
  _resetRpc()
  _resetWorkspaceSessions()
})

test("a feed left open through many changes keeps at most MAX_FEED_EVENTS", async () => {
  _setRpc({
    activity: {
      getActivityEvents: mock(() => Promise.resolve({ events: Array.from({ length: 100 }, event).reverse(), error: undefined })),
      // Every change brings 25 events the feed has not seen.
      getActivityEventsSince: mock(() => Promise.resolve({ events: Array.from({ length: 25 }, event).reverse(), error: undefined })),
    },
  } as unknown as RemoteApi)
  let length = 0
  const onEventsChange = (events: ActivityEvent[]) => {
    length = events.length
  }
  const props = { dbPath: "/tmp/cap/.beads", workspaceId: "id-cap", onEventsChange }
  const { rerender } = render(<ActivityFeed {...props} changeSignal={0} />)
  await waitFor(() => expect(length).toBe(100))

  const changes = 30 // 100 + 30 x 25 = 850 events offered
  for (let signal = 1; signal <= changes; signal++) {
    rerender(<ActivityFeed {...props} changeSignal={signal} />)
    const before = issued
    await waitFor(() => expect(issued).toBeGreaterThan(before), { timeout: 3_000 }) // the debounced fetch ran
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
  }
  expect(issued).toBe(100 + changes * 25)
  expect(length).toBeLessThanOrEqual(MAX_FEED_EVENTS)
  expect(sessionActivityEvents.get("id-cap")?.length ?? 0).toBeLessThanOrEqual(MAX_FEED_EVENTS)
  // The newest events are the ones kept.
  expect(sessionActivityEvents.get("id-cap")?.[0]?.issue_id).toBe(`cap-${issued}`)
}, 60_000)
