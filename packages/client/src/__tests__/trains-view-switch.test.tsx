// Trains had no view-switch keys; ⌘5 must reach the Chart view from it too
// (beadbox-eic).

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
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { StartupGate } from "../components/startup-gate"
import { queryClient } from "../lib/query-client"
import { _setRpc, type RemoteApi } from "../lib/rpc"
import type { Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

const ws: Workspace = {
  id: "3f1b8a24-0000-4000-8000-0000000c4a48",
  name: "trains-ws",
  path: "/tmp/trains-ws",
  databasePath: "/tmp/trains-ws/.beads",
  mode: "embedded",
}

let TrainsPage: typeof import("../components/trains-page").TrainsPage

beforeAll(async () => {
  const anyCall = () => mock(() => Promise.resolve({ success: true, data: [], epics: [] }))
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
    workspaces: new Proxy(
      { getWorkspaces: mock(() => Promise.resolve([ws])) },
      { get: (t, k) => (k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve())) },
    ),
  }
  _setRpc(
    new Proxy(api, {
      get: (t, k) => (k in t ? t[k as keyof typeof t] : new Proxy({}, { get: anyCall })),
    }) as unknown as RemoteApi,
  )
  TrainsPage = (await import("../components/trains-page")).TrainsPage
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
})

describe("Trains view switching", () => {
  test("⌘5 opens the Chart view", async () => {
    setWorkspaceCookie(ws.id)
    const rootRoute = createRootRoute({
      component: () => (
        <StartupGate>
          <Outlet />
        </StartupGate>
      ),
    })
    const routeTree = rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/trains", component: TrainsPage }),
      createRoute({ getParentRoute: () => rootRoute, path: "/chart", component: () => <p>CHART VIEW</p> }),
      createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
    ])
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/trains"] }) })
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    )
    expect(await screen.findByRole("heading", { name: "Trains" }, { timeout: 5_000 })).toBeTruthy()
    fireEvent.keyDown(window, { key: "5", metaKey: true })
    expect(await screen.findByText("CHART VIEW", {}, { timeout: 5_000 })).toBeTruthy()
  }, 20_000)
})
