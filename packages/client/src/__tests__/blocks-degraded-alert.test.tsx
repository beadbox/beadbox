// When the sidecar cannot compute blocked-by, the tree must say so on screen
// (beadbox-01f.5 AC3). An empty map reads as "nothing is blocked", which is
// how bd's column rename hid every blocker from bd >= 1.2 users; a message in
// the devtools console is not visible to them either.

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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { StartupGate } from "../components/startup-gate"
import { queryClient } from "../lib/query-client"
import { _setRpc, type RemoteApi } from "../lib/rpc"
import type { Epic, Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

const ws: Workspace = {
  id: "3f1b8a24-0000-4000-8000-00000001f5a3",
  name: "blocks-ws",
  path: "/tmp/blocks-ws",
  databasePath: "/tmp/blocks-ws/.beads",
  mode: "embedded",
}

function tree(): Epic[] {
  return [
    {
      id: "bk-1",
      type: "epic",
      title: "Blocked-by epic",
      status: "open",
      priority: "medium",
      labels: [],
      children: [],
    } as unknown as Epic,
  ]
}

type BlocksPayload = { blockedBy: Record<string, string[]>; degraded?: { reason: "error"; message: string } }

// What the sidecar answers for blocked-by; each test sets it.
let blocksAnswer: BlocksPayload = { blockedBy: {} }
let HomePage: typeof import("../components/home-page").HomePage
let getBlocksDependencies: ReturnType<typeof mock>

beforeAll(async () => {
  getBlocksDependencies = installRpc()
  HomePage = (await import("../components/home-page")).HomePage
})

function installRpc() {
  const getBlocks = mock(() => Promise.resolve(blocksAnswer))
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
      {
        getEpics: mock(() => Promise.resolve({ success: true as const, epics: tree() })),
        getBlocksDependencies: getBlocks,
      },
      {
        get: (t, k) =>
          k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve({ success: true, data: [] })),
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
  return getBlocks
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

const unavailable = /Blocked-by markers are unavailable/

afterEach(() => {
  cleanup()
  getBlocksDependencies.mockClear()
  queryClient.clear()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
  blocksAnswer = { blockedBy: {} }
})

describe("home page: blocked-by that could not be computed is shown (beadbox-01f.5)", () => {
  test("a degraded result puts a visible notice with bd's reason above the tree", async () => {
    blocksAnswer = { blockedBy: {}, degraded: { reason: "error", message: "failed to open database" } }
    setWorkspaceCookie(ws.id)
    mountHome()

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(unavailable), { timeout: 5_000 })
    expect(screen.getByRole("alert").textContent).toContain("failed to open database")
  }, 20_000)

  test("Retry asks again, and a successful answer clears the notice", async () => {
    blocksAnswer = { blockedBy: {}, degraded: { reason: "error", message: "failed to open database" } }
    setWorkspaceCookie(ws.id)
    mountHome()
    await waitFor(() => expect(screen.getByText(unavailable)).toBeTruthy(), { timeout: 5_000 })
    const asked = getBlocksDependencies.mock.calls.length

    blocksAnswer = { blockedBy: {} }
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(getBlocksDependencies.mock.calls.length).toBeGreaterThan(asked), { timeout: 5_000 })
    await waitFor(() => expect(screen.queryByText(unavailable)).toBeNull(), { timeout: 5_000 })
  }, 20_000)

  test("control: an ok answer, even an empty one, shows no notice", async () => {
    setWorkspaceCookie(ws.id)
    mountHome()
    await waitFor(() => expect(screen.getByText("Blocked-by epic")).toBeTruthy(), { timeout: 5_000 })
    await waitFor(() => expect(getBlocksDependencies.mock.calls.length).toBeGreaterThan(0), { timeout: 5_000 })
    expect(screen.queryByText(unavailable)).toBeNull()
  }, 20_000)
})
