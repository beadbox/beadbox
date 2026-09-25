// ActivityFeed — session cache contract.
//
// The router unmounts this route on every navigation away, so re-entering
// /activity used to start from `events: []` + `loading: true` and repaint the
// loading placeholder for events it had a second earlier. The feed now seeds
// from the per-workspace session cache and refreshes behind the paint.

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

import { ActivityFeed } from "../components/activity-feed"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { ActivityEvent } from "../lib/types"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

const ALPHA_ID = "id-alpha"
const BETA_ID = "id-beta"

function event(issueId: string, message: string): ActivityEvent {
  return {
    timestamp: "2026-09-03T10:00:00Z",
    type: "create",
    issue_id: issueId,
    symbol: "+",
    message,
  }
}

const EVENTS_BY_WORKSPACE: Record<string, ActivityEvent[]> = {
  [ALPHA_ID]: [event("demo-alpha-1", "created alpha bead")],
  [BETA_ID]: [event("demo-beta-1", "created beta bead")],
}

function installRpc(options: { defer?: boolean } = {}) {
  const pending: Array<() => void> = []
  const getActivityEvents = mock((workspaceId?: string) => {
    const payload = { events: EVENTS_BY_WORKSPACE[workspaceId ?? ""] ?? [], error: undefined }
    if (!options.defer) return Promise.resolve(payload)
    return new Promise<typeof payload>((resolve) => {
      pending.push(() => resolve(payload))
    })
  })
  _setRpc({
    activity: {
      getActivityEvents,
      getActivityEventsSince: mock(() => Promise.resolve({ events: [], error: undefined })),
    },
  } as unknown as RemoteApi)
  return { getActivityEvents, release: () => pending.shift()?.() }
}

afterEach(() => {
  cleanup()
  _resetRpc()
  _resetWorkspaceSessions()
})

describe("ActivityFeed session cache", () => {
  test("re-entering the route paints cached events instead of the placeholder", async () => {
    const first = installRpc()
    render(<ActivityFeed dbPath="/tmp/alpha/.beads" workspaceId={ALPHA_ID} />)
    expect(await screen.findByText("demo-alpha-1")).toBeTruthy()

    // Navigate away and back: a fresh mount, with the fetch still in flight.
    cleanup()
    _resetRpc()
    const second = installRpc({ defer: true })
    render(<ActivityFeed dbPath="/tmp/alpha/.beads" workspaceId={ALPHA_ID} />)

    // Painted from the cache before the refresh resolves.
    expect(screen.getByText("demo-alpha-1")).toBeTruthy()
    // And the refresh really is in flight — this is not a frozen view.
    expect(second.getActivityEvents).toHaveBeenCalledTimes(1)
    second.release()
    await waitFor(() => {
      expect(screen.getByText("demo-alpha-1")).toBeTruthy()
    })
    expect(first.getActivityEvents).toHaveBeenCalledTimes(1)
  })

  test("an in-place workspace switch does not show the previous project's events", async () => {
    installRpc()
    const { rerender } = render(<ActivityFeed dbPath="/tmp/alpha/.beads" workspaceId={ALPHA_ID} />)
    expect(await screen.findByText("demo-alpha-1")).toBeTruthy()

    // The rail can switch workspace without remounting the route.
    rerender(<ActivityFeed dbPath="/tmp/beta/.beads" workspaceId={BETA_ID} />)
    expect(screen.queryByText("demo-alpha-1")).toBeNull()
    expect(await screen.findByText("demo-beta-1")).toBeTruthy()

    // Back to alpha: cached, so its events are there without waiting.
    rerender(<ActivityFeed dbPath="/tmp/alpha/.beads" workspaceId={ALPHA_ID} />)
    expect(screen.getByText("demo-alpha-1")).toBeTruthy()
    expect(screen.queryByText("demo-beta-1")).toBeNull()
  })

  test("a workspace with nothing cached still shows the placeholder", async () => {
    const { getActivityEvents, release } = installRpc({ defer: true })
    const { container } = render(<ActivityFeed dbPath="/tmp/alpha/.beads" workspaceId={ALPHA_ID} />)

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(getActivityEvents).toHaveBeenCalledTimes(1)

    release()
    expect(await screen.findByText("demo-alpha-1")).toBeTruthy()
  })
})
