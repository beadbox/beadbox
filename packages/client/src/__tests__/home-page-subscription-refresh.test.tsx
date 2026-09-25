// The home page rebuilds the epic tree on every subscription `change`
// (beadbox-s5z), whatever made the write: a detail-panel edit, the bd CLI, or
// another agent. PR #45 stops the detail panel from ALSO reloading the tree
// after each field edit, which makes this subscription reload the only
// authoritative refresh for field edits — so it needs a test of its own
// (beadbox-01f.9).

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"

import { StartupGate } from "../components/startup-gate"
import { queryClient } from "../lib/query-client"
import { _setRpc, type RemoteApi } from "../lib/rpc"
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

beforeAll(async () => {
  getEpics = installRpc().getEpics
  HomePage = (await import("../components/home-page")).HomePage
})

function installRpc() {
  const getEpics = mock(() => Promise.resolve({ success: true as const, epics: tree() }))
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
      { getEpics, getBlocksDependencies: mock(() => Promise.resolve({ blockedBy: {} })) },
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
  return { getEpics }
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

afterEach(() => {
  cleanup()
  getEpics.mockClear()
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
})
