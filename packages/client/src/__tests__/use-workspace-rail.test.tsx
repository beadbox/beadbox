// useWorkspaceRail — switch / remove / persistence contract.
//
// The rail's risky logic is here, not in the JSX: a switch is a cookie
// write plus a registry update, and removing the active workspace has to
// promote a survivor instead of leaving the app pointed at a dead entry.
// rpc is injected through the _setRpc seam (same pattern as
// change-subscription-mount.test.tsx); the hook needs router context, so
// it mounts inside a memory router with the two routes it navigates to.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { act, cleanup, render, waitFor } from "@testing-library/react"

import { useWorkspaceRail, type WorkspaceRailController } from "../hooks/use-workspace-rail"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { WorkspaceCard } from "../lib/types"
import {
  clearWorkspaceCookie,
  getWorkspaceCookie,
  setWorkspaceCookie,
} from "../lib/workspace-cookie"
import { subscribeWorkspaceLabels, type WorkspaceLabelChange } from "../lib/workspace-labels"
import { publishWorkspaceRegistryChange } from "../lib/workspace-registry-events"

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

function installRpc(
  workspaces: WorkspaceCard[],
  removeResult: { success: true; credentialKey?: string } | { success: false; error: string } = {
    success: true,
  },
  labelResult?: { success: false; error: string },
) {
  const mocks = {
    getRegisteredWorkspacesForSelector: mock(() => Promise.resolve(workspaces)),
    setActiveWorkspaceAction: mock((_databasePath: string) => Promise.resolve()),
    removeWorkspace: mock((_databasePath: string) => Promise.resolve(removeResult)),
    setWorkspaceLabel: mock((workspaceId: string, label: { name?: string; icon?: string | null }) =>
      Promise.resolve(
        labelResult ?? {
          success: true as const,
          workspace: {
            ...(workspaces.find((w) => w.id === workspaceId) ?? workspaces[0]),
            ...(label.name === undefined ? {} : { name: label.name }),
            icon: label.icon ?? undefined,
          },
        },
      ),
    ),
  }
  _setRpc({ workspaces: mocks } as unknown as RemoteApi)
  return mocks
}

function mountRail(initialPath: string) {
  const seen: { current: WorkspaceRailController | null } = { current: null }

  function Probe() {
    seen.current = useWorkspaceRail()
    return null
  }

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Probe />
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
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })

  render(<RouterProvider router={router as never} />)
  return { seen, router }
}

async function railAt(initialPath: string, workspaces: WorkspaceCard[]) {
  const mocks = installRpc(workspaces)
  const { seen, router } = mountRail(initialPath)
  await waitFor(() => {
    expect(seen.current?.workspaces).toHaveLength(workspaces.length)
  })
  return { mocks, seen, router }
}

beforeEach(() => {
  clearWorkspaceCookie()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  _resetRpc()
  clearWorkspaceCookie()
  localStorage.clear()
})

describe("useWorkspaceRail", () => {
  test("loads the registry and mirrors the active cookie", async () => {
    setWorkspaceCookie(beta.id)
    const { mocks, seen } = await railAt("/", [alpha, beta])
    expect(mocks.getRegisteredWorkspacesForSelector).toHaveBeenCalledTimes(1)
    expect(seen.current?.activeWorkspaceId).toBe(beta.id)
    expect(seen.current?.dashboardActive).toBe(false)
  })

  test("switching writes the cookie and persists the registry active workspace", async () => {
    setWorkspaceCookie(alpha.id)
    const { mocks, seen } = await railAt("/", [alpha, beta])

    await act(async () => {
      await seen.current?.selectWorkspace(beta)
    })

    expect(getWorkspaceCookie()).toBe(beta.id)
    expect(mocks.setActiveWorkspaceAction).toHaveBeenCalledTimes(1)
    // databasePath, not the UUID (bb-qn71).
    expect(mocks.setActiveWorkspaceAction.mock.calls[0]?.[0]).toBe(beta.databasePath)
    expect(seen.current?.activeWorkspaceId).toBe(beta.id)
  })

  test("switching keeps the current view, and leaves the dashboard for the workspace", async () => {
    setWorkspaceCookie(alpha.id)
    const onDashboard = await railAt("/workspaces", [alpha, beta])
    expect(onDashboard.seen.current?.dashboardActive).toBe(true)

    await act(async () => {
      await onDashboard.seen.current?.selectWorkspace(beta)
    })
    await waitFor(() => {
      expect(onDashboard.router.state.location.pathname).toBe("/")
    })

    cleanup()
    _resetRpc()
    setWorkspaceCookie(alpha.id)
    const onBeads = await railAt("/", [alpha, beta])
    await act(async () => {
      await onBeads.seen.current?.selectWorkspace(beta)
    })
    expect(onBeads.router.state.location.pathname).toBe("/")
  })

  test("re-clicking the active workspace does not re-run the switch", async () => {
    setWorkspaceCookie(alpha.id)
    const { mocks, seen } = await railAt("/", [alpha, beta])

    await act(async () => {
      await seen.current?.selectWorkspace(alpha)
    })

    expect(mocks.setActiveWorkspaceAction).not.toHaveBeenCalled()
  })

  test("clicking the active workspace from the dashboard opens it", async () => {
    setWorkspaceCookie(alpha.id)
    const { mocks, seen, router } = await railAt("/workspaces", [alpha, beta])

    await act(async () => {
      await seen.current?.selectWorkspace(alpha)
    })

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/")
    })
    expect(mocks.setActiveWorkspaceAction).not.toHaveBeenCalled()
  })

  test("removing a non-active workspace drops it and keeps the active one", async () => {
    setWorkspaceCookie(alpha.id)
    const { mocks, seen } = await railAt("/", [alpha, beta])

    await act(async () => {
      await seen.current?.removeWorkspace(beta)
    })

    expect(mocks.removeWorkspace.mock.calls[0]?.[0]).toBe(beta.databasePath)
    expect(seen.current?.workspaces.map((w) => w.id)).toEqual([alpha.id])
    expect(getWorkspaceCookie()).toBe(alpha.id)
  })

  test("removing the active workspace promotes the survivor", async () => {
    setWorkspaceCookie(alpha.id)
    const { mocks, seen } = await railAt("/", [alpha, beta])

    await act(async () => {
      await seen.current?.removeWorkspace(alpha)
    })

    expect(getWorkspaceCookie()).toBe(beta.id)
    expect(mocks.setActiveWorkspaceAction.mock.calls[0]?.[0]).toBe(beta.databasePath)
    expect(seen.current?.workspaces.map((w) => w.id)).toEqual([beta.id])
  })

  test("removing the last workspace clears the cookie and returns to the dashboard", async () => {
    setWorkspaceCookie(alpha.id)
    const { seen, router } = await railAt("/", [alpha])

    await act(async () => {
      await seen.current?.removeWorkspace(alpha)
    })

    expect(getWorkspaceCookie()).toBeNull()
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/workspaces")
    })
  })

  test("a failed removal keeps the workspace in the rail", async () => {
    installRpc([alpha, beta], { success: false, error: "registry locked" })
    const { seen } = mountRail("/")
    await waitFor(() => {
      expect(seen.current?.workspaces).toHaveLength(2)
    })

    await act(async () => {
      await seen.current?.removeWorkspace(beta)
    })

    expect(seen.current?.workspaces).toHaveLength(2)
  })

  test("re-reads the registry when another surface announces a membership change", async () => {
    // The rail is mounted outside the dashboard, so an add performed there
    // reaches it only through this announcement. Without it the rail kept a
    // stale list until the next bd subscription bump.
    const registry = [alpha]
    const { mocks, seen } = await railAt("/", registry)
    expect(seen.current?.workspaces.map((w) => w.id)).toEqual([alpha.id])

    registry.push(beta)
    await act(async () => {
      publishWorkspaceRegistryChange()
    })

    await waitFor(() => {
      expect(seen.current?.workspaces.map((w) => w.id)).toEqual([alpha.id, beta.id])
    })
    expect(mocks.getRegisteredWorkspacesForSelector).toHaveBeenCalledTimes(2)
  })

  test("relabel writes the registry, patches the tab and publishes the label", async () => {
    const { mocks, seen } = await railAt("/", [alpha, beta])
    const published: WorkspaceLabelChange[] = []
    const unsubscribe = subscribeWorkspaceLabels((change) => published.push(change))

    await act(async () => {
      await seen.current?.relabelWorkspace(alpha, { name: "Alpha prod" })
    })

    expect(mocks.setWorkspaceLabel.mock.calls[0]?.[0]).toBe(alpha.id)
    expect(mocks.setWorkspaceLabel.mock.calls[0]?.[1]).toEqual({ name: "Alpha prod" })
    expect(seen.current?.workspaces.find((w) => w.id === alpha.id)?.name).toBe("Alpha prod")
    expect(published).toEqual([{ workspaceId: alpha.id, name: "Alpha prod", icon: undefined }])

    await act(async () => {
      await seen.current?.relabelWorkspace(alpha, { icon: "🚀" })
    })
    expect(seen.current?.workspaces.find((w) => w.id === alpha.id)?.icon).toBe("🚀")

    unsubscribe()
  })

  test("a rejected relabel leaves the tab untouched", async () => {
    installRpc([alpha, beta], { success: true }, { success: false, error: "Name cannot be empty." })
    const { seen } = mountRail("/")
    await waitFor(() => {
      expect(seen.current?.workspaces).toHaveLength(2)
    })

    await act(async () => {
      await seen.current?.relabelWorkspace(alpha, { name: "   " })
    })

    expect(seen.current?.workspaces.find((w) => w.id === alpha.id)?.name).toBe(alpha.name)
  })

  test("collapse state and width round-trip through localStorage", async () => {
    localStorage.setItem("beadbox_workspace_rail_width", "300")
    const { seen } = await railAt("/", [alpha])

    expect(seen.current?.width).toBe(300)
    expect(seen.current?.collapsed).toBe(false)

    act(() => {
      seen.current?.toggleCollapse()
    })

    expect(seen.current?.collapsed).toBe(true)
    expect(localStorage.getItem("beadbox_workspace_rail_collapsed")).toBe("true")
  })

  test("width is clamped to the rail's min/max on read", async () => {
    localStorage.setItem("beadbox_workspace_rail_width", "9000")
    const { seen } = await railAt("/", [alpha])
    expect(seen.current?.width).toBe(420)
  })
})
