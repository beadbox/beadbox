// useWorkspaceLifecycle — in-place workspace switches.
//
// Two behaviours the workspace rail depends on:
//   1. A cookie write switches the active workspace without a remount
//      (StartupGate skips its re-check for verified workspaces, so nothing
//      else would notice).
//   2. Switching back to a workspace loaded earlier in the session paints
//      its cached tree immediately — hasExistingDataRef stays true, which is
//      what suppresses home-page's skeleton while the refresh runs.

import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { act, cleanup, render, waitFor } from "@testing-library/react"

import type { AppHealth } from "../hooks/use-app-health"
import { useWorkspaceLifecycle } from "../hooks/use-workspace-lifecycle"
import { _resetSessionEpics } from "../lib/epics-session-cache"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { Epic, Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"

const alpha: Workspace = {
  id: "id-alpha",
  name: "alpha",
  path: "/tmp/alpha",
  databasePath: "/tmp/alpha/.beads",
  mode: "embedded",
}

const beta: Workspace = {
  id: "id-beta",
  name: "beta",
  path: "/tmp/beta",
  databasePath: "/tmp/beta/.beads",
  mode: "embedded",
}

function epic(id: string): Epic {
  return { id, type: "epic", title: id, children: [] } as unknown as Epic
}

const EPICS_BY_DB: Record<string, Epic[]> = {
  [alpha.databasePath as string]: [epic("alpha-1")],
  [beta.databasePath as string]: [epic("beta-1"), epic("beta-2")],
}

type LifecycleResult = ReturnType<typeof useWorkspaceLifecycle>

interface Harness {
  seen: { current: LifecycleResult | null }
  getEpics: ReturnType<typeof mock>
  /** Resolve the deferred getEpics call, if one is pending. */
  release: () => void
}

function mountLifecycle(options: { deferAfter?: number } = {}): Harness {
  let calls = 0
  let pendingResolve: (() => void) | null = null

  const getEpics = mock((dbPath?: string) => {
    calls += 1
    const payload = { success: true as const, epics: EPICS_BY_DB[dbPath ?? ""] ?? [] }
    if (options.deferAfter !== undefined && calls > options.deferAfter) {
      return new Promise<typeof payload>((resolve) => {
        pendingResolve = () => resolve(payload)
      })
    }
    return Promise.resolve(payload)
  })

  _setRpc({
    epics: { getEpics },
    workspaces: {
      getWorkspaces: mock(() => Promise.resolve([alpha, beta])),
      setActiveWorkspaceAction: mock(() => Promise.resolve()),
    },
    beads: {
      getAvailableStatuses: mock(() => Promise.resolve(["open", "in_progress", "closed"])),
      getCustomStatusList: mock(() => Promise.resolve([])),
    },
  } as unknown as RemoteApi)

  const seen: { current: LifecycleResult | null } = { current: null }
  const healthy: AppHealth = { status: "healthy" }

  function Probe() {
    seen.current = useWorkspaceLifecycle({
      initialWorkspaces: [alpha, beta],
      appHealth: healthy,
      appHealthRef: { current: healthy },
      setHealthy: () => {},
      setDegraded: () => {},
      setHealthError: () => {},
      setFatal: () => {},
    })
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  render(<RouterProvider router={router as never} />)

  return { seen, getEpics, release: () => pendingResolve?.() }
}

afterEach(() => {
  cleanup()
  _resetRpc()
  _resetSessionEpics()
  clearWorkspaceCookie()
})

describe("useWorkspaceLifecycle workspace switching", () => {
  test("a cookie write switches the active workspace and loads its epics", async () => {
    setWorkspaceCookie(alpha.id)
    const { seen } = mountLifecycle()

    await waitFor(() => {
      expect(seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
    })

    await act(async () => {
      setWorkspaceCookie(beta.id)
    })
    await waitFor(() => {
      expect(seen.current?.currentWorkspace?.id).toBe(beta.id)
    })
    await waitFor(() => {
      expect(seen.current?.epics.map((e) => e.id)).toEqual(["beta-1", "beta-2"])
    })
  })

  test("switching back paints the cached tree before the refresh lands", async () => {
    setWorkspaceCookie(alpha.id)
    // Calls 1 (alpha) and 2 (beta) resolve; call 3 (alpha again) hangs so we
    // can observe what the UI shows while a refresh is in flight.
    const { seen, release } = mountLifecycle({ deferAfter: 2 })

    await waitFor(() => {
      expect(seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
    })

    await act(async () => {
      setWorkspaceCookie(beta.id)
    })
    await waitFor(() => {
      expect(seen.current?.epics.map((e) => e.id)).toEqual(["beta-1", "beta-2"])
    })

    await act(async () => {
      setWorkspaceCookie(alpha.id)
    })

    // Cached tree is on screen immediately, and hasExistingDataRef stays true
    // so home-page keeps rendering it instead of the skeleton.
    expect(seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
    expect(seen.current?.hasExistingDataRef.current).toBe(true)

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(seen.current?.isLoading).toBe(false)
    })
    expect(seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
  })

  test("a never-before-loaded workspace has no cached tree to paint", async () => {
    setWorkspaceCookie(alpha.id)
    const { seen } = mountLifecycle({ deferAfter: 1 })

    await waitFor(() => {
      expect(seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
    })

    await act(async () => {
      setWorkspaceCookie(beta.id)
    })

    // No cache for beta: the skeleton gate opens (hasExistingData false)
    // rather than showing alpha's beads as if they were beta's.
    expect(seen.current?.hasExistingDataRef.current).toBe(false)
    expect(seen.current?.isLoading).toBe(true)
  })
})
