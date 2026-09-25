// StartupGate — per-workspace startup cache.
//
// Switching projects used to re-run the startup health check every time,
// which unmounts the gate's children and flashes "Starting up...". The
// gate now remembers which workspaces passed a check this session and
// adopts a switch back to one of them silently: no extra
// runStartupHealth call, children never unmount.
//
// The gate reads router state, so it mounts inside a memory router.

import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { StartupGate } from "../components/startup-gate"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"

const alpha: Workspace = {
  id: "3f1b8a24-0000-4000-8000-00000000a001",
  name: "alpha",
  path: "/tmp/alpha",
  databasePath: "/tmp/alpha/.beads",
  mode: "embedded",
}

const beta: Workspace = {
  id: "3f1b8a24-0000-4000-8000-00000000b002",
  name: "beta",
  path: "/tmp/beta",
  databasePath: "/tmp/beta/.beads",
  mode: "embedded",
}

const unknownWorkspaceId = "3f1b8a24-0000-4000-8000-00000000c003"

function installHealthRpc(workspaces: Workspace[], options: { defer?: boolean } = {}) {
  const pending: Array<() => void> = []
  const runStartupHealth = mock((activeId?: string) => {
    const payload = {
      platform: "darwin",
      hasWorkspaces: true,
      workspaces,
      activeWorkspaceId: activeId ?? workspaces[0]?.id,
      healthCheck: { ok: true as const },
      bdVersion: "1.2.2",
      bdPath: "/opt/homebrew/bin/bd",
    }
    if (!options.defer) return Promise.resolve(payload)
    return new Promise<typeof payload>((resolve) => {
      pending.push(() => resolve(payload))
    })
  })
  _setRpc({ health: { runStartupHealth } } as unknown as RemoteApi)
  return {
    runStartupHealth,
    /** Resolve the oldest outstanding health check. */
    release: () => pending.shift()?.(),
  }
}

// Counts mounts so an unmount/remount of the gate's children is visible.
let mountCount = 0

function mountGate() {
  function Child() {
    return <span data-testid="gate-child">child</span>
  }

  function Layout() {
    return (
      <StartupGate>
        <Outlet />
      </StartupGate>
    )
  }

  const rootRoute = createRootRoute({ component: Layout })
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => {
        mountCount += 1
        return <Child />
      },
    }),
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
  mountCount = 0
})

describe("StartupGate workspace cache", () => {
  test("switching back to an already-checked workspace does not re-run the health check", async () => {
    setWorkspaceCookie(alpha.id)
    const { runStartupHealth } = installHealthRpc([alpha, beta])
    mountGate()

    await waitFor(() => {
      expect(screen.getByTestId("gate-child")).toBeTruthy()
    })
    expect(runStartupHealth).toHaveBeenCalledTimes(1)

    // First visit to beta: not verified yet → full check.
    await act(async () => {
      setWorkspaceCookie(beta.id)
    })
    await waitFor(() => {
      expect(runStartupHealth).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByTestId("gate-child")).toBeTruthy()
    })
    // Baseline taken after the one legitimate re-check: that switch does
    // unmount the route (new workspace, unknown health).
    const mountsAfterFullCheck = mountCount

    // Back to alpha: verified during boot → adopted silently.
    await act(async () => {
      setWorkspaceCookie(alpha.id)
    })
    await waitFor(() => {
      expect(screen.getByTestId("gate-child")).toBeTruthy()
    })
    expect(runStartupHealth).toHaveBeenCalledTimes(2)

    // And back to beta, also verified now.
    await act(async () => {
      setWorkspaceCookie(beta.id)
    })
    expect(runStartupHealth).toHaveBeenCalledTimes(2)
    // No re-check means the route component was never remounted.
    expect(mountCount).toBe(mountsAfterFullCheck)
  })

  test("switching to a workspace that was never checked runs the health check", async () => {
    setWorkspaceCookie(alpha.id)
    const { runStartupHealth } = installHealthRpc([alpha, beta])
    mountGate()

    await waitFor(() => {
      expect(screen.getByTestId("gate-child")).toBeTruthy()
    })
    expect(runStartupHealth).toHaveBeenCalledTimes(1)

    await act(async () => {
      setWorkspaceCookie(unknownWorkspaceId)
    })
    await waitFor(() => {
      expect(runStartupHealth).toHaveBeenCalledTimes(2)
    })
  })
})

describe("StartupGate mid-check workspace switch", () => {
  test("a workspace switched to while a check is in flight gets its own check", async () => {
    setWorkspaceCookie(alpha.id)
    const { runStartupHealth, release } = installHealthRpc([alpha, beta], { defer: true })
    mountGate()

    await waitFor(() => {
      expect(runStartupHealth).toHaveBeenCalledTimes(1)
    })

    // Switch to beta while alpha's check is still outstanding. The rail is
    // mounted outside the gate precisely so this is clickable.
    await act(async () => {
      setWorkspaceCookie(beta.id)
    })

    // Alpha's result lands: it must be recorded against alpha, and beta must
    // still be checked rather than inheriting alpha's verdict.
    await act(async () => {
      release()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(runStartupHealth).toHaveBeenCalledTimes(2)
    })
    expect(runStartupHealth.mock.calls[1]?.[0]).toBe(beta.id)

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId("gate-child")).toBeTruthy()
    })
    // Beta is verified now, so going back to alpha (verified first) and to
    // beta again adds no further checks.
    await act(async () => {
      setWorkspaceCookie(alpha.id)
    })
    await act(async () => {
      setWorkspaceCookie(beta.id)
    })
    expect(runStartupHealth).toHaveBeenCalledTimes(2)
  })
})

describe("StartupGate transport failure", () => {
  test("shows a retryable error when startup RPC rejects, then recovers", async () => {
    setWorkspaceCookie(alpha.id)
    const { runStartupHealth } = installHealthRpc([alpha])
    runStartupHealth.mockImplementationOnce(() => Promise.reject(new Error("Sidecar exited")))
    mountGate()

    await waitFor(() => {
      expect(screen.getByText("Sidecar exited")).toBeTruthy()
    })
    expect(screen.queryByText("Starting up...")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => {
      expect(screen.getByTestId("gate-child")).toBeTruthy()
    })
    expect(runStartupHealth).toHaveBeenCalledTimes(2)
  })
})
