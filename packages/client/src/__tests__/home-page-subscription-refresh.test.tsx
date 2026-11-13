// The home page rebuilds the epic tree on every subscription `change`
// (beadbox-s5z), whatever made the write: a detail-panel edit, the bd CLI, or
// another agent. PR #45 stops the detail panel from ALSO reloading the tree
// after each field edit, which makes this subscription reload the only
// authoritative refresh for field edits — so it needs a test of its own
// (beadbox-01f.9).

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"

import { StartupGate } from "../components/startup-gate"
import {
  _resetHiddenRefreshClockForTests,
  _setHiddenRefreshClockForTests,
  HIDDEN_REFRESH_INTERVAL_MS,
  type HiddenRefreshClock,
} from "../hooks/use-workspace-lifecycle"
import { queryClient } from "../lib/query-client"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import { _emitChangeForTests, _resetSubscriptionChangeCount } from "../lib/subscribe"
import type { Epic, Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

const ws: Workspace = {
  id: "3f1b8a24-0000-4000-8000-0000000001f9",
  name: "refresh-ws",
  path: "/tmp/refresh-ws",
  databasePath: "/tmp/refresh-ws/.beads",
  mode: "embedded",
}

// What bd would return. The test rewrites it the way a CLI edit would.
let treeTitle = "Title before"

function tree(): Epic[] {
  return [
    {
      id: "rf-1",
      type: "epic",
      title: treeTitle,
      status: "open",
      priority: "medium",
      labels: [],
      children: [],
    } as unknown as Epic,
  ]
}

// home-page.tsx and the hooks it pulls in bind some rpc methods at MODULE
// load (e.g. `const getBlocksDependencies = rpc.epics.getBlocksDependencies`),
// so the mocks are installed once, before HomePage is imported, and shared by
// every test; call counts are cleared between tests instead.
let HomePage: typeof import("../components/home-page").HomePage
let getEpics: ReturnType<typeof installRpc>["getEpics"]
let getBlocksDependencies: ReturnType<typeof installRpc>["getBlocksDependencies"]

beforeAll(async () => {
  const installed = installRpc()
  getEpics = installed.getEpics
  getBlocksDependencies = installed.getBlocksDependencies
  HomePage = (await import("../components/home-page")).HomePage
})

function installRpc() {
  const getEpics = mock(() => Promise.resolve({ success: true as const, epics: tree() }))
  const getBlocksDependencies = mock(() => Promise.resolve({ blockedBy: {} }))
  // Anything the page calls that this test does not assert on resolves to an
  // empty-but-valid result.
  const benign = (): RemoteApi[keyof RemoteApi] =>
    new Proxy(
      {},
      { get: () => mock(() => Promise.resolve({ success: true, data: [], epics: [] })) },
    ) as never
  const api = {
    health: {
      runStartupHealth: mock(() =>
        Promise.resolve({
          platform: "darwin",
          hasWorkspaces: true,
          workspaces: [{ ...ws, databasePath: `${ws.databasePath}/beads.db` }],
          activeWorkspaceId: ws.id,
          healthCheck: { ok: true as const },
          bdVersion: "1.2.2",
          bdPath: "/opt/homebrew/bin/bd",
        }),
      ),
    },
    epics: new Proxy(
      { getEpics, getBlocksDependencies },
      {
        get: (t, k) =>
          k in t
            ? t[k as keyof typeof t]
            : mock(() => Promise.resolve({ success: true, data: [] })),
      },
    ),
    workspaces: new Proxy(
      { getWorkspaces: mock(() => Promise.resolve([ws])) },
      {
        get: (t, k) => (k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve())),
      },
    ),
    beads: new Proxy(
      {
        getAvailableStatuses: mock(() => Promise.resolve(["open", "in_progress", "closed"])),
        getCustomStatusList: mock(() => Promise.resolve([])),
        // The workspace type catalog (bd types) is a list; the catch-all
        // below would answer with an object (beadbox-01f.13).
        getAvailableTypes: mock(() => Promise.resolve(["task", "epic"])),
      },
      {
        get: (t, k) =>
          k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve({ success: true })),
      },
    ),
  }
  _setRpc(
    new Proxy(api, {
      get: (t, k) => (k in t ? t[k as keyof typeof t] : benign()),
    }) as unknown as RemoteApi,
  )
  return { getEpics, getBlocksDependencies }
}

function mountHome() {
  const rootRoute = createRootRoute({
    component: () => (
      <StartupGate>
        <Outlet />
      </StartupGate>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  // The app's own queryClient: the one a subscription change invalidates.
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

function createVirtualClock(initialNow = 1_000) {
  let currentNow = initialNow
  let nextId = 1
  const tasks = new Map<number, { due: number; id: number; cb: () => void }>()
  const clock: HiddenRefreshClock = {
    now: () => currentNow,
    schedule: (cb, ms) => {
      const id = nextId++
      tasks.set(id, { due: currentNow + Math.max(0, ms), id, cb })
      return id as unknown as ReturnType<typeof globalThis.setTimeout>
    },
    cancel: (handle) => {
      tasks.delete(handle as unknown as number)
    },
  }
  const advance = async (ms: number, onStep?: () => Promise<void>) => {
    const target = currentNow + ms
    while (true) {
      let earliest: { due: number; id: number; cb: () => void } | null = null
      for (const entry of tasks.values()) {
        if (
          entry.due <= target &&
          (!earliest ||
            entry.due < earliest.due ||
            (entry.due === earliest.due && entry.id < earliest.id))
        ) {
          earliest = entry
        }
      }
      if (!earliest) break
      tasks.delete(earliest.id)
      currentNow = earliest.due
      earliest.cb()
      if (onStep) await onStep()
    }
    currentNow = target
  }
  return { clock, advance }
}

afterEach(() => {
  _resetHiddenRefreshClockForTests()
  Reflect.deleteProperty(document, "visibilityState")
  cleanup()
  getEpics.mockClear()
  getBlocksDependencies.mockClear()
  queryClient.clear()
  _resetSubscriptionChangeCount()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
  treeTitle = "Title before"
})

describe("home page: a subscription change rebuilds the tree (beadbox-s5z)", () => {
  test("a write made outside the panel (e.g. bd CLI) shows up after the change event", async () => {
    setWorkspaceCookie(ws.id)
    mountHome()

    await waitFor(() => expect(screen.getByText("Title before")).toBeTruthy(), { timeout: 5_000 })
    const before = getEpics.mock.calls.length
    expect(before).toBeGreaterThan(0)

    // bd committed a write the page did not make; the sidecar reports it.
    treeTitle = "Title after, edited from the CLI"
    await act(async () => {
      _emitChangeForTests()
    })

    await waitFor(() => expect(getEpics.mock.calls.length).toBeGreaterThan(before), {
      timeout: 5_000,
    })
    await waitFor(() => expect(screen.getByText("Title after, edited from the CLI")).toBeTruthy(), {
      timeout: 5_000,
    })
    expect(screen.queryByText("Title before")).toBeNull()
  }, 20_000)

  test("no change event, no reload (the refetch above is the event's doing)", async () => {
    setWorkspaceCookie(ws.id)
    mountHome()
    await waitFor(() => expect(screen.getByText("Title before")).toBeTruthy(), { timeout: 5_000 })
    const settled = getEpics.mock.calls.length
    await new Promise((r) => setTimeout(r, 1_000))
    expect(getEpics.mock.calls.length).toBe(settled)
  }, 20_000)

  test("hidden subscription changes coalesce into the capped refresh without firing uncached blocked-by reads", async () => {
    const intervalMs = HIDDEN_REFRESH_INTERVAL_MS
    const vclock = createVirtualClock()
    _setHiddenRefreshClockForTests(vclock.clock)
    const flushMicrotasks = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }

    setWorkspaceCookie(ws.id)
    mountHome()
    await waitFor(() => expect(screen.getByText("Title before")).toBeTruthy(), { timeout: 5_000 })
    await waitFor(() => expect(getBlocksDependencies.mock.calls.length).toBeGreaterThan(0), {
      timeout: 5_000,
    })

    const epicsBefore = getEpics.mock.calls.length
    const blocksBefore = getBlocksDependencies.mock.calls.length

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
      document.dispatchEvent(new Event("visibilitychange"))
      treeTitle = "Title updated while hidden"
      for (let i = 0; i < 10; i++) {
        _emitChangeForTests()
        await Promise.resolve()
      }
    })

    // Suppressed events must neither refetch epics early nor fire uncached getBlocksDependencies reads.
    expect(getEpics.mock.calls.length).toBe(epicsBefore)
    expect(getBlocksDependencies.mock.calls.length).toBe(blocksBefore)

    await act(async () => {
      await vclock.advance(intervalMs, flushMicrotasks)
      await flushMicrotasks()
    })

    expect(getEpics.mock.calls.length).toBe(epicsBefore + 1)
    expect(getBlocksDependencies.mock.calls.length).toBe(blocksBefore + 1)
    expect(screen.getByText("Title updated while hidden")).toBeTruthy()
  }, 20_000)
})

// Put the default rpc back after this file, so the mock installed above
// cannot leak into a later test file (beadbox-r72.4).
afterAll(() => _resetRpc())
