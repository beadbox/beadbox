// WorkspaceRailPanel — the container's own wiring: the remove-confirm
// dialog, and the viewport gate that keeps the rail (and its registry
// fetch) out of the mobile layout entirely.

import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { WorkspaceRailPanel } from "../components/workspace-rail-panel"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { WorkspaceCard } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"

const userInstance = () => userEvent.setup({ delay: null })

const alpha: WorkspaceCard = {
  id: "id-alpha",
  name: "alpha",
  path: "/tmp/alpha",
  databasePath: "/tmp/alpha/.beads",
  mode: "embedded",
  available: true,
}

const beta: WorkspaceCard = {
  id: "id-beta",
  name: "beta",
  path: "/tmp/beta",
  databasePath: "/tmp/beta/.beads",
  mode: "embedded",
  available: true,
}

function installRpc() {
  const mocks = {
    getRegisteredWorkspacesForSelector: mock(() => Promise.resolve([alpha, beta])),
    removeWorkspace: mock((_databasePath: string) => Promise.resolve({ success: true as const })),
    setActiveWorkspaceAction: mock((_databasePath: string) => Promise.resolve()),
  }
  _setRpc({ workspaces: mocks } as unknown as RemoteApi)
  return mocks
}

function mountPanel() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <WorkspaceRailPanel />
        <Outlet />
      </>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
    createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  render(<RouterProvider router={router as never} />)
}

afterEach(() => {
  cleanup()
  _resetRpc()
  clearWorkspaceCookie()
})

describe("WorkspaceRailPanel", () => {
  test("removing a tab goes through the confirm dialog before unregistering", async () => {
    setWorkspaceCookie(alpha.id)
    const mocks = installRpc()
    const user = userInstance()
    mountPanel()

    await waitFor(() => {
      expect(screen.getAllByTestId("workspace-rail-item")).toHaveLength(2)
    })

    await user.click(screen.getByRole("button", { name: "Workspace options for beta" }))
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }))

    // Nothing is unregistered until the confirmation is accepted.
    expect(await screen.findByText("Remove workspace?")).toBeTruthy()
    expect(mocks.removeWorkspace).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(mocks.removeWorkspace).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Workspace options for beta" }))
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }))
    await user.click(await screen.findByRole("button", { name: "Remove" }))

    await waitFor(() => {
      expect(mocks.removeWorkspace).toHaveBeenCalledTimes(1)
    })
    expect(mocks.removeWorkspace.mock.calls[0]?.[0]).toBe(beta.databasePath)
    await waitFor(() => {
      expect(screen.getAllByTestId("workspace-rail-item")).toHaveLength(1)
    })
  })

  test("the mobile layout renders no rail", async () => {
    setWorkspaceCookie(alpha.id)
    installRpc()
    const original = window.innerWidth
    // useViewport starts at its desktop default and corrects in an effect,
    // so the assertion is on the settled render.
    window.innerWidth = 500
    try {
      mountPanel()
      await waitFor(() => {
        expect(screen.queryByTestId("workspace-rail")).toBeNull()
      })
    } finally {
      window.innerWidth = original
    }
  })
})
