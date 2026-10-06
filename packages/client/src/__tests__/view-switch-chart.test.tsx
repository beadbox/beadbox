// ⌘5 opens the Chart view from the Activity and Formulas views, through each
// page's own view-switch handler (beadbox-eic).

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
  id: "3f1b8a24-0000-4000-8000-0000000c4a49",
  name: "switch-ws",
  path: "/tmp/switch-ws",
  databasePath: "/tmp/switch-ws/.beads",
  mode: "embedded",
}

let ActivityPage: typeof import("../components/activity-page").ActivityPage
let FormulasView: typeof import("../components/formulas-view").FormulasView

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
    beads: new Proxy(
      {
        getAvailableStatuses: mock(() => Promise.resolve(["open", "in_progress", "closed"])),
        getCustomStatusList: mock(() => Promise.resolve([])),
        checkBeadExists: mock(() => Promise.resolve(false)),
      },
      { get: (t, k) => (k in t ? t[k as keyof typeof t] : anyCall()) },
    ),
    activity: new Proxy(
      {
        listBeadsByStatus: mock(() => Promise.resolve({ beads: [] })),
        getActivityEvents: mock(() => Promise.resolve({ events: [], error: undefined })),
        getActivityEventsSince: mock(() => Promise.resolve({ events: [], error: undefined })),
      },
      { get: (t, k) => (k in t ? t[k as keyof typeof t] : anyCall()) },
    ),
  }
  _setRpc(
    new Proxy(api, {
      get: (t, k) => (k in t ? t[k as keyof typeof t] : new Proxy({}, { get: anyCall })),
    }) as unknown as RemoteApi,
  )
  ActivityPage = (await import("../components/activity-page")).ActivityPage
  FormulasView = (await import("../components/formulas-view")).FormulasView
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
})

function mountAt(path: string, Page: () => React.JSX.Element) {
  setWorkspaceCookie(ws.id)
  const rootRoute = createRootRoute({
    component: () => (
      <StartupGate>
        <Outlet />
      </StartupGate>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path, component: Page }),
    createRoute({ getParentRoute: () => rootRoute, path: "/chart", component: () => <p>CHART VIEW</p> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
  ])
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

describe("⌘5 from views with their own handler", () => {
  for (const [name, path, page] of [
    ["Activity", "/activity", () => ActivityPage],
    ["Formulas", "/formulas", () => FormulasView],
  ] as const) {
    test(`${name}: ⌘5 opens the Chart view`, async () => {
      mountAt(path, page())
      // The header is part of the page, so its key handler is mounted too.
      await screen.findByRole("button", { name: "Chart" }, { timeout: 5_000 })
      expect(screen.queryByText("CHART VIEW")).toBeNull()
      fireEvent.keyDown(window, { key: "5", metaKey: true })
      expect(await screen.findByText("CHART VIEW", {}, { timeout: 5_000 })).toBeTruthy()
    }, 20_000)
  }
})
