// beadbox-fdk: a registered workspace whose .beads has vanished must show a
// visible, named error with a way out, never an empty workspace. The sidecar
// reports it as workspace_missing without running bd (which would litter an
// embeddeddolt/ there and answer an empty list at exit 0).

import { afterEach, describe, expect, test } from "bun:test"
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
  id: "3f1b8a24-0000-4000-8000-00000000f0dk",
  name: "vanished",
  path: "/tmp/vanished",
  databasePath: "/tmp/vanished/.beads",
  mode: "embedded",
}

function mountGate() {
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
            error: { kind: "workspace_missing", path: "/tmp/vanished/.beads" },
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
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>TREE</p> }),
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

describe("StartupGate: workspace folder missing", () => {
  test("names the problem and the path, and offers a way out; no empty tree", async () => {
    const { container } = mountGate()
    await waitFor(() => expect(screen.getByText("Workspace folder not found")).toBeTruthy())
    expect(container.textContent).toContain("/tmp/vanished/.beads")
    expect(screen.getByRole("button", { name: /Remove workspace/ })).toBeTruthy()
    expect(container.textContent).not.toContain("TREE")
  })
})
