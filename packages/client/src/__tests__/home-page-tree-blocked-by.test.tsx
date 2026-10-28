// beadbox-kqiv: blocked-by arrives with the tree, and nothing re-commits the
// tree afterwards. The page used to load a tree without blocked-by and then
// patch it in from getBlocksDependencies, one request later, on every change;
// a molecule's phases (grouped by blocked-by) collapsed into Phase 1 for those
// frames. Here the blocked-by answer deliberately disagrees with the tree: the
// screen must keep showing the tree's own blocked-by, before and after a
// subscription change.

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
import { queryClient } from "../lib/query-client"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import { _emitChangeForTests, _resetSubscriptionChangeCount } from "../lib/subscribe"
import type { Epic, Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

const ws: Workspace = {
  id: "3f1b8a24-0000-4000-8000-00000000a1b9",
  name: "tree-blocked-ws",
  path: "/tmp/tree-blocked-ws",
  databasePath: "/tmp/tree-blocked-ws/.beads",
  mode: "embedded",
}

function tree(): Epic[] {
  return [
    {
      id: "_standalone",
      type: "epic",
      title: "Beads (No Epic)",
      status: "open",
      priority: "low",
      labels: [],
      comments: [],
      childEpics: [],
      children: [
        {
          id: "tb-2",
          type: "task",
          title: "Loose step",
          status: "open",
          priority: "medium",
          labels: [],
          comments: [],
          blockedBy: [{ id: "tb-1", title: "From the tree" }],
        },
      ],
    } as unknown as Epic,
  ]
}

// home-page binds some rpc methods at module load, so the mocks go in before
// HomePage is imported (see home-page-subscription-refresh.test.tsx).
let HomePage: typeof import("../components/home-page").HomePage
let getEpics: ReturnType<typeof mock>
let getBlocksDependencies: ReturnType<typeof mock>

beforeAll(async () => {
  ;({ getEpics, getBlocksDependencies } = installRpc())
  HomePage = (await import("../components/home-page")).HomePage
})

function installRpc() {
  const getEpics = mock(() => Promise.resolve({ success: true as const, epics: tree() }))
  // Disagrees with the tree on purpose: if this reaches the screen, the page
  // patched the tree after loading it.
  const getBlocksDependencies = mock(() =>
    Promise.resolve({ blockedBy: { "tb-2": ["tb-patched"] } }),
  )
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
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

/** The loose bead's row text, where its blocked-by chip renders. */
const rowText = () => document.querySelector('[data-item-id="tb-2"]')?.textContent ?? ""

/** Let every pending promise and the effects they schedule run. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 300)))

afterEach(() => {
  cleanup()
  getEpics.mockClear()
  getBlocksDependencies.mockClear()
  queryClient.clear()
  _resetSubscriptionChangeCount()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
})

describe("home page: blocked-by comes with the tree (beadbox-kqiv)", () => {
  test("the tree's blocked-by stays on screen through the load and a change event", async () => {
    setWorkspaceCookie(ws.id)
    mountHome()

    await waitFor(() => expect(screen.getByText("Loose step")).toBeTruthy(), { timeout: 5_000 })
    // The page still asks for blocked-by after a load (for the unavailable banner).
    await waitFor(() => expect(getBlocksDependencies.mock.calls.length).toBeGreaterThan(0), {
      timeout: 5_000,
    })
    await settle()
    expect(rowText()).toMatch(/after\s*tb-1/)
    expect(rowText()).not.toContain("tb-patched")

    const asked = getBlocksDependencies.mock.calls.length
    await act(async () => {
      _emitChangeForTests()
    })
    await waitFor(() => expect(getBlocksDependencies.mock.calls.length).toBeGreaterThan(asked), {
      timeout: 5_000,
    })
    await settle()
    expect(rowText()).toMatch(/after\s*tb-1/)
    expect(rowText()).not.toContain("tb-patched")
  }, 20_000)
})

afterAll(() => _resetRpc())
