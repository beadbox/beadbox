// StartupGate — beadbox-287: a server workspace whose scaffold has a different
// project identity than the server gets an actionable screen (re-add the
// workspace, with Remove offered), not "Startup error" and bd's raw text.

import { afterEach, expect, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

import { StartupGate } from "../components/startup-gate"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { Workspace } from "../lib/types"
import { clearWorkspaceCookie } from "../lib/workspace-cookie"

const ws: Workspace = {
  id: "3f1b8a24-0000-4000-8000-00000000e287",
  name: "team_beads",
  path: "/tmp/scaffold",
  databasePath: "/tmp/scaffold/.beads",
  mode: "server",
}

function mountFailingGate() {
  _setRpc({
    health: {
      runStartupHealth: () =>
        Promise.resolve({
          platform: "darwin",
          hasWorkspaces: true,
          workspaces: [ws],
          activeWorkspaceId: ws.id,
          healthCheck: {
            ok: false as const,
            error: {
              kind: "project_identity_mismatch",
              database: "team_beads",
              localId: "29ae6d48-c4c6-4df6-b12c-089f2b315526",
              databaseId: "328c14ec-4172-44bb-a87b-e06a37ab19fa",
            },
          },
        }),
    },
  } as unknown as RemoteApi)

  function Layout() {
    return (
      <StartupGate>
        <Outlet />
      </StartupGate>
    )
  }
  const rootRoute = createRootRoute({ component: Layout })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
    createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  return render(<RouterProvider router={router as never} />)
}

afterEach(() => {
  cleanup()
  _resetRpc()
  clearWorkspaceCookie()
})

test("explains the mismatch and offers Remove workspace", async () => {
  mountFailingGate()
  await waitFor(() => expect(screen.getByText("Workspace needs to reconnect")).toBeTruthy())
  expect(screen.queryByText("Startup error")).toBeNull()
  expect(screen.getByText(/29ae6d48/)).toBeTruthy()
  expect(screen.getByText(/328c14ec/)).toBeTruthy()
  expect(screen.getByText(/add the server again/)).toBeTruthy()
  expect(screen.getByRole("button", { name: /Remove workspace/ })).toBeTruthy()
})
