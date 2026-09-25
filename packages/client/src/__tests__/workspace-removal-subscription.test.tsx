// Removing a workspace ends its live-update subscription (beadbox-wja).
//
// Found by qa1: removing a server workspace left its poll loop running. The
// subscription's path stayed pinned to the removed workspace, because
// ChangeSubscriptionMount ignored a null resolution and the startup machine
// kept the removed workspace in its list after NO_WORKSPACES. When that
// server was down, 01f.2's pause watchdog resubscribed the removed workspace
// and showed "Live updates paused" on a Welcome screen with no workspaces.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { WorkspaceGateContext } from "../components/startup-gate"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import { INITIAL_STATE, transition } from "../lib/startup-machine"
import {
  _getLiveUpdatesPaused,
  _resetListenStderr,
  _resetLiveUpdatesPaused,
  _resetLivenessTiming,
  _resetRuntimeCheck,
  _setListenStderr,
  _setLivenessTiming,
  _setLiveUpdatesPausedForTests,
  _setRuntimeCheck,
} from "../lib/subscribe"
import type { Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { ChangeSubscriptionMount } from "../routes/__root"

type TestWorkspace = Workspace & { databasePath: string }
const A: TestWorkspace = {
  id: "00000000-0000-4000-8000-00000000a0a0",
  name: "A",
  databasePath: "/tmp/wja-a/.beads",
  mode: "server",
}
const B: TestWorkspace = {
  id: "00000000-0000-4000-8000-00000000b0b0",
  name: "B",
  databasePath: "/tmp/wja-b/.beads",
  mode: "server",
}

let starts: string[] = []
let stops: string[] = []
let ids: Record<string, string> = {}
let feed: ((data: string) => void) | null = null

function installRpc(): void {
  starts = []
  stops = []
  ids = {}
  let n = 0
  _setRpc({
    subscribe: {
      start: mock(async (path: string) => {
        starts.push(path)
        n += 1
        ids[path] = `wja-${n}`
        return { id: `wja-${n}` }
      }),
      stop: mock(async (id: string) => {
        stops.push(id)
      }),
    },
  } as unknown as RemoteApi)
  _setListenStderr((async (_name: string, fn: (data: string) => void) => {
    feed = fn
    return () => {}
  }) as unknown as Parameters<typeof _setListenStderr>[0])
}

function Gate({ workspaces, children }: { workspaces: Workspace[]; children?: ReactNode }) {
  return createElement(
    WorkspaceGateContext.Provider,
    { value: { workspaces, refreshWorkspaces: () => {} } },
    children,
  )
}

const settle = () => new Promise((r) => setTimeout(r, 0))
let container: HTMLElement
let root: Root

async function render(workspaces: Workspace[]): Promise<void> {
  await act(async () => {
    root.render(createElement(Gate, { workspaces }, createElement(ChangeSubscriptionMount)))
  })
  await act(async () => {
    await settle()
    await settle()
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  _setRuntimeCheck(() => true)
  _setLivenessTiming({ pauseAfterMs: 60, tickMs: 20 })
  installRpc()
  clearWorkspaceCookie()
})

afterEach(() => {
  try {
    root.unmount()
  } catch {
    /* already unmounted */
  }
  container.remove()
  _resetRpc()
  _resetListenStderr()
  _resetRuntimeCheck()
  _resetLivenessTiming()
  _resetLiveUpdatesPaused()
  clearWorkspaceCookie()
  feed = null
})

describe("removing a workspace ends its subscription", () => {
  test("removing the only workspace stops its subscription; the watchdog never resubscribes it", async () => {
    setWorkspaceCookie(A.id)
    await render([A])
    expect(starts).toEqual([A.databasePath])
    // A heartbeat arms 01f.2's watchdog for this subscription.
    await act(async () => feed?.(`[SUBSCRIPTION:${ids[A.databasePath]}] {"type":"heartbeat"}\n`))

    clearWorkspaceCookie()
    await render([])
    // Past the pause window, with no heartbeats (as if A's server were down).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250))
    })
    expect(stops).toContain(ids[A.databasePath])
    expect(starts).toEqual([A.databasePath])
    expect(_getLiveUpdatesPaused()).toBe(false)
  })

  test("removing one of two moves the subscription to the other", async () => {
    setWorkspaceCookie(A.id)
    await render([A, B])
    clearWorkspaceCookie()
    await render([B])
    expect(starts[starts.length - 1]).toBe(B.databasePath)
    expect(stops).toContain(ids[A.databasePath])
  })

  test("a pause that belonged to the removed workspace clears when no workspace remains", async () => {
    setWorkspaceCookie(A.id)
    await render([A])
    _setLiveUpdatesPausedForTests(true)
    expect(_getLiveUpdatesPaused()).toBe(true)
    clearWorkspaceCookie()
    await render([])
    expect(_getLiveUpdatesPaused()).toBe(false)
  })
})

test("the startup machine forgets the removed workspaces when the registry is empty", () => {
  const healthy = transition(transition(INITIAL_STATE, { type: "BOOT" }), {
    type: "HEALTH_OK",
    workspaces: [A],
  })
  expect(healthy.workspaces).toEqual([A])
  const checking = transition(healthy, { type: "WORKSPACE_CHANGED" })
  const empty = transition(checking, { type: "NO_WORKSPACES" })
  expect(empty.phase).toBe("no_registry")
  expect(empty.workspaces).toEqual([])
})
