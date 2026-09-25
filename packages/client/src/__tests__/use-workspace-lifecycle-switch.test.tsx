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
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { Epic, Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

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

// The sidecar hands the client two spellings of one workspace's
// databasePath: runStartupHealth resolves "<project>/.beads/beads.db"
// (resolveBdDbPath) and getWorkspaces resolves "<project>/.beads"
// (resolveLocalEntry). StartupGate's list — this hook's initialWorkspaces —
// carries the first; the list the hook refreshes carries the second.
function healthSpelling(workspace: Workspace): Workspace {
  return { ...workspace, databasePath: `${workspace.databasePath}/beads.db` }
}

function mountLifecycle(
  options: {
    deferAfter?: number
    rejectStatuses?: boolean
    getAvailableTypes?: (dbPath?: string) => Promise<string[]>
  } = {},
): Harness {
  let calls = 0
  let pendingResolve: (() => void) | null = null

  const getEpics = mock((dbPath?: string) => {
    calls += 1
    const key = (dbPath ?? "").replace(/\/beads\.db$/, "")
    const payload = { success: true as const, epics: EPICS_BY_DB[key] ?? [] }
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
      getAvailableTypes: mock(options.getAvailableTypes ?? (() => Promise.resolve(["task"]))),
      getAvailableStatuses: mock(() =>
        options.rejectStatuses
          ? Promise.reject(new Error("Sidecar exited"))
          : Promise.resolve(["open", "in_progress", "closed"]),
      ),
      getCustomStatusList: mock(() =>
        options.rejectStatuses ? Promise.reject(new Error("Sidecar exited")) : Promise.resolve([]),
      ),
    },
  } as unknown as RemoteApi)

  const seen: { current: LifecycleResult | null } = { current: null }
  const healthy: AppHealth = { status: "healthy" }

  function Probe() {
    seen.current = useWorkspaceLifecycle({
      // As StartupGate supplies them.
      initialWorkspaces: [healthSpelling(alpha), healthSpelling(beta)],
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
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
})

describe("useWorkspaceLifecycle workspace switching", () => {
  test("retry keeps type edits disabled until the current catalog succeeds", async () => {
    setWorkspaceCookie(alpha.id)
    let releaseRetry: (() => void) | undefined
    let calls = 0
    const { seen } = mountLifecycle({
      getAvailableTypes: () => {
        calls++
        if (calls === 1) return Promise.reject(new Error("catalog timed out"))
        return new Promise<string[]>((resolve) => {
          releaseRetry = () => resolve(["task", "decision"])
        })
      },
    })
    await waitFor(() => expect(seen.current?.typeCatalogError).toBe("catalog timed out"))
    expect(seen.current?.typeCatalogReady).toBe(false)

    act(() => seen.current?.retryAvailableTypes())
    expect(seen.current?.typeCatalogRetrying).toBe(true)
    expect(seen.current?.typeCatalogReady).toBe(false)
    expect(seen.current?.typeCatalogError).toBe("catalog timed out")

    await act(async () => releaseRetry?.())
    await waitFor(() => expect(seen.current?.typeCatalogReady).toBe(true))
    expect(seen.current?.availableTypes).toEqual(["task", "decision"])
    expect(seen.current?.typeCatalogError).toBeNull()
  })

  test("late retry response from the previous workspace cannot replace current types", async () => {
    setWorkspaceCookie(alpha.id)
    let releaseAlpha: (() => void) | undefined
    let alphaCalls = 0
    const { seen } = mountLifecycle({
      getAvailableTypes: (dbPath) => {
        if (dbPath?.includes("beta")) return Promise.resolve(["beta-type"])
        alphaCalls++
        if (alphaCalls === 1) return Promise.reject(new Error("catalog timed out"))
        return new Promise<string[]>((resolve) => {
          releaseAlpha = () => resolve(["alpha-type"])
        })
      },
    })
    await waitFor(() => expect(seen.current?.typeCatalogError).toBe("catalog timed out"))
    act(() => seen.current?.retryAvailableTypes())
    await act(async () => setWorkspaceCookie(beta.id))
    await waitFor(() => expect(seen.current?.currentWorkspace?.id).toBe(beta.id))
    await waitFor(() => expect(seen.current?.availableTypes).toEqual(["beta-type"]))

    await act(async () => releaseAlpha?.())
    expect(seen.current?.availableTypes).toEqual(["beta-type"])
    expect(seen.current?.typeCatalogReady).toBe(true)
  })

  test("status RPC failures do not block the workspace tree", async () => {
    setWorkspaceCookie(alpha.id)
    const { seen } = mountLifecycle({ rejectStatuses: true })

    await waitFor(() => {
      expect(seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
    })
  })

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

  test("a remount paints the cached tree instead of the skeleton", async () => {
    setWorkspaceCookie(alpha.id)
    const first = mountLifecycle()
    await waitFor(() => {
      expect(first.seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
    })

    // Whatever remounts this hook — a StartupGate re-check, a retry, dev
    // StrictMode — the tree it already loaded must survive.
    cleanup()
    const second = mountLifecycle({ deferAfter: 0 })
    await waitFor(() => {
      expect(second.seen.current?.currentWorkspace?.id).toBe(alpha.id)
    })
    expect(second.seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
    // home-page's skeleton gate: isLoading && !hasExistingDataRef.current
    expect(second.seen.current?.hasExistingDataRef.current).toBe(true)

    second.release()
  })

  test("the cache survives the sidecar's two databasePath spellings", async () => {
    // Regression: the session cache used to be keyed by databasePath, so a
    // tree loaded through StartupGate's list ("…/.beads/beads.db") was
    // invisible to a switch resolved through getWorkspaces ("…/.beads") and
    // every other visit repainted the skeleton.
    setWorkspaceCookie(alpha.id)
    const { seen } = mountLifecycle()
    await waitFor(() => {
      expect(seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
    })
    // The mounted workspace came from the health-spelled list.
    expect(seen.current?.currentWorkspace?.databasePath).toBe(`${alpha.databasePath}/beads.db`)

    await act(async () => {
      setWorkspaceCookie(beta.id)
    })
    await waitFor(() => {
      expect(seen.current?.epics.map((e) => e.id)).toEqual(["beta-1", "beta-2"])
    })

    // Back to alpha, now resolved from the refreshed (bare .beads) list.
    await act(async () => {
      setWorkspaceCookie(alpha.id)
    })
    expect(seen.current?.currentWorkspace?.databasePath).toBe(alpha.databasePath as string)
    expect(seen.current?.epics.map((e) => e.id)).toEqual(["alpha-1"])
    expect(seen.current?.hasExistingDataRef.current).toBe(true)
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
