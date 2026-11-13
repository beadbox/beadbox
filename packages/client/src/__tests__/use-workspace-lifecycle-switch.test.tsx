// useWorkspaceLifecycle — in-place workspace switches.
//
// Two behaviours the workspace rail depends on:
//   1. A cookie write switches the active workspace without a remount
//      (StartupGate skips its re-check for verified workspaces, so nothing
//      else would notice).
//   2. Switching back to a workspace loaded earlier in the session paints
//      its cached tree immediately — hasExistingDataRef stays true, which is
//      what suppresses home-page's skeleton while the refresh runs.

import { afterEach, describe, expect, jest, mock, test } from "bun:test"
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
import * as lifecycleModule from "../hooks/use-workspace-lifecycle"
import { systemIssuesKey, useWorkspaceLifecycle } from "../hooks/use-workspace-lifecycle"
import { ERROR_CATEGORY_TITLES } from "../lib/epic-tree-utils"
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
  /** Health transitions the hook requested, in order. */
  health: Array<{ kind: "fatal" | "error"; message: string; autoRetry?: boolean }>
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
    getEpicsResult?: unknown
    treeRequest?: (dbPath?: string, includeSystem?: boolean) => Promise<unknown>
  } = {},
): Harness {
  let calls = 0
  let pendingResolve: (() => void) | null = null

  const getEpics = mock((dbPath?: string, includeSystem?: boolean) => {
    if (options.treeRequest) return options.treeRequest(dbPath, includeSystem)
    calls += 1
    const key = (dbPath ?? "").replace(/\/beads\.db$/, "")
    const payload = { success: true as const, epics: EPICS_BY_DB[key] ?? [] }
    if (options.getEpicsResult !== undefined) return Promise.resolve(options.getEpicsResult)
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
  const health: Harness["health"] = []

  function Probe() {
    seen.current = useWorkspaceLifecycle({
      // As StartupGate supplies them.
      initialWorkspaces: [healthSpelling(alpha), healthSpelling(beta)],
      appHealth: healthy,
      appHealthRef: { current: healthy },
      setHealthy: () => {},
      setDegraded: () => {},
      setHealthError: (message, _error, autoRetry) => {
        health.push({ kind: "error", message, autoRetry })
      },
      setFatal: (message) => {
        health.push({ kind: "fatal", message })
      },
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

  return { seen, health, getEpics, release: () => pendingResolve?.() }
}

interface FakeTimerControls {
  useFakeTimers: () => void
  useRealTimers: () => void
  advanceTimersByTime: (ms: number) => void
}
const timers = jest as unknown as FakeTimerControls

afterEach(() => {
  timers.useRealTimers()
  Reflect.deleteProperty(document, "visibilityState")
  cleanup()
  _resetRpc()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
  localStorage.removeItem(systemIssuesKey(alpha.id))
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

  // beadbox-uk2: a workspace whose bd list output is past the sidecar's
  // ceiling must read as a named failure, not an empty tree behind an
  // auto-retry that returns the same output every time.
  test("an output-too-large tree load is fatal, titled, and not auto-retried", async () => {
    setWorkspaceCookie(alpha.id)
    const message =
      "bd returned more output than Beadbox will read (32 MiB limit). This workspace is too large to load in one call."
    const { seen, health } = mountLifecycle({
      getEpicsResult: {
        success: false,
        bdLoadError: {
          category: "output-too-large",
          severity: "fatal",
          message,
          stderr: null,
          fixCommand: null,
          fixDescription: null,
        },
      },
    })
    await waitFor(() => expect(health.some((h) => h.kind === "fatal")).toBe(true))
    expect(health.find((h) => h.kind === "fatal")?.message).toContain("32 MiB")
    expect(health.filter((h) => h.kind === "error")).toEqual([])
    expect(seen.current?.autoRetryCountdown ?? null).toBeNull()
    expect(ERROR_CATEGORY_TITLES["output-too-large"]).toBe("Workspace too large to load")
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

describe("tree refresh admission", () => {
  test("a slow refresh burst admits one request and one latest follow-up", async () => {
    setWorkspaceCookie(alpha.id)
    const pending: Array<(value: unknown) => void> = []
    const { seen, getEpics } = mountLifecycle({
      treeRequest: () => new Promise((resolve) => pending.push(resolve)),
    })
    await waitFor(() => expect(getEpics.mock.calls.length).toBe(1))
    act(() => {
      for (let n = 0; n < 20; n++) void seen.current?.loadEpics()
    })
    expect(getEpics.mock.calls.length).toBe(1)
    await act(async () => pending.shift()?.({ success: true, epics: [epic("old")] }))
    await waitFor(() => expect(getEpics.mock.calls.length).toBe(2))
    await act(async () => pending.shift()?.({ success: true, epics: [epic("newest")] }))
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("newest"))
    expect(getEpics.mock.calls.length).toBe(2)
  })

  test("hidden changes fetch nothing and showing runs one catch-up", async () => {
    setWorkspaceCookie(alpha.id)
    const { seen, getEpics } = mountLifecycle()
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-1"))
    const count = getEpics.mock.calls.length
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"))
        for (let n = 0; n < 20; n++) void seen.current?.loadEpics()
      })
      expect(getEpics.mock.calls.length).toBe(count)
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      await act(async () => document.dispatchEvent(new Event("visibilitychange")))
      await waitFor(() => expect(getEpics.mock.calls.length).toBe(count + 1))
    } finally {
      Reflect.deleteProperty(document, "visibilityState")
    }
  })

  test("a workspace switch starts immediately and discards the in-flight old tree", async () => {
    setWorkspaceCookie(alpha.id)
    const pending: Array<{ db?: string; resolve: (value: unknown) => void }> = []
    const { seen } = mountLifecycle({
      treeRequest: (db) => new Promise((resolve) => pending.push({ db, resolve })),
    })
    await waitFor(() => expect(pending.length).toBe(1))
    await act(async () => setWorkspaceCookie(beta.id))
    await waitFor(() => expect(pending.length).toBe(2))
    await act(async () => pending.shift()?.resolve({ success: true, epics: [epic("stale-alpha")] }))
    await waitFor(() => expect(pending.some((p) => p.db?.includes("beta"))).toBe(true))
    expect(seen.current?.epics.some((e) => e.id === "stale-alpha")).toBe(false)
    await act(async () =>
      pending
        .find((p) => p.db?.includes("beta"))
        ?.resolve({ success: true, epics: [epic("latest-beta")] }),
    )
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("latest-beta"))
  })
})

describe("review: switch latency", () => {
  test("switching away from a stalled workspace starts the new load at once", async () => {
    setWorkspaceCookie(alpha.id)
    const pending: Array<{ db?: string; resolve: (value: unknown) => void }> = []
    mountLifecycle({
      treeRequest: (db) => new Promise((resolve) => pending.push({ db, resolve })),
    })
    await waitFor(() => expect(pending.length).toBe(1))
    await act(async () => setWorkspaceCookie(beta.id))
    // alpha never answers (a stalled workspace)
    await waitFor(() => expect(pending.some((p) => p.db?.includes("beta"))).toBe(true), {
      timeout: 1500,
    })
  })
})

test("switching system-issue mode does not wait for the previous mode", async () => {
  setWorkspaceCookie(alpha.id)
  const pending: Array<{ all?: boolean; resolve: (value: unknown) => void }> = []
  const { seen } = mountLifecycle({
    treeRequest: (_db, all) => new Promise((resolve) => pending.push({ all, resolve })),
  })
  await waitFor(() => expect(pending.length).toBe(1))
  await act(async () => seen.current?.setIncludeSystem(true))
  await waitFor(() => expect(pending.map((p) => p.all)).toEqual([false, true]))
  await act(async () => pending[1].resolve({ success: true, epics: [epic("all-issues")] }))
  await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("all-issues"))
  await act(async () => pending[0].resolve({ success: true, epics: [epic("stale-normal")] }))
  expect(seen.current?.epics[0]?.id).toBe("all-issues")
  expect(seen.current?.isLoading).toBe(false)
  act(() => seen.current?.setIncludeSystem(false))
})

test("an old workspace's dirty follow-up cannot join the current workspace burst", async () => {
  setWorkspaceCookie(alpha.id)
  const pending: Array<{ db?: string; resolve: (value: unknown) => void }> = []
  const { seen, getEpics } = mountLifecycle({
    treeRequest: (db) => new Promise((resolve) => pending.push({ db, resolve })),
  })
  await waitFor(() => expect(pending.length).toBe(1))
  act(() => {
    for (let n = 0; n < 5; n++) void seen.current?.loadEpics()
  })
  await act(async () => setWorkspaceCookie(beta.id))
  await waitFor(() => expect(pending.length).toBe(2))
  act(() => {
    for (let n = 0; n < 10; n++) void seen.current?.loadEpics()
  })
  await act(async () => pending[0].resolve({ success: true, epics: [epic("old-alpha")] }))
  expect(getEpics.mock.calls.length).toBe(2)
  await act(async () => pending[1].resolve({ success: true, epics: [epic("older-beta")] }))
  await waitFor(() => expect(pending.length).toBe(3))
  await act(async () => pending[2].resolve({ success: true, epics: [epic("latest-beta")] }))
  await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("latest-beta"))
  expect(getEpics.mock.calls.length).toBe(3)
})

test("a refresh arriving as the current drain settles is not lost", async () => {
  setWorkspaceCookie(alpha.id)
  const pending: Array<(value: unknown) => void> = []
  const { seen, getEpics } = mountLifecycle({
    treeRequest: () => new Promise((resolve) => pending.push(resolve)),
  })
  await waitFor(() => expect(pending.length).toBe(1))
  await act(async () => {
    pending[0]({ success: true, epics: [epic("first")] })
    await Promise.resolve()
    await Promise.resolve()
    void seen.current?.loadEpics()
  })
  await waitFor(() => expect(getEpics.mock.calls.length).toBe(2))
  await act(async () => pending[1]({ success: true, epics: [epic("latest")] }))
  await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("latest"))
})

describe("capped hidden refresh (beadbox-1jq)", () => {
  const getHiddenIntervalMs = () =>
    (lifecycleModule as { HIDDEN_REFRESH_INTERVAL_MS?: number }).HIDDEN_REFRESH_INTERVAL_MS ??
    30_000

  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }

  test("hidden burst over 2 minutes runs at most ceil(120/interval)+1 non-overlapping refreshes and delivers latest data within one interval", async () => {
    const intervalMs = getHiddenIntervalMs()
    expect(intervalMs).toBeGreaterThanOrEqual(30_000)
    expect(intervalMs).toBeLessThanOrEqual(60_000)

    let latestEpicId = "alpha-initial"
    let inFlight = 0
    let maxInFlight = 0

    setWorkspaceCookie(alpha.id)
    const { seen, getEpics } = mountLifecycle({
      treeRequest: () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        const snapshot = latestEpicId
        return Promise.resolve({ success: true as const, epics: [epic(snapshot)] }).finally(() => {
          inFlight -= 1
        })
      },
    })
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-initial"))

    timers.useFakeTimers()
    // Advance past initial mount so the 2-minute hidden window starts from steady state.
    await act(async () => {
      timers.advanceTimersByTime(intervalMs * 2)
      await flushMicrotasks()
    })
    const callsBeforeHidden = getEpics.mock.calls.length

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })

    // 240 changes across 120s (every 500ms).
    const totalChanges = 240
    for (let i = 1; i <= totalChanges; i++) {
      latestEpicId = `hidden-change-${i}`
      await act(async () => {
        void seen.current?.loadEpics()
        if (i < totalChanges) {
          timers.advanceTimersByTime(500)
        }
        await flushMicrotasks()
      })
    }

    // Latest data must arrive within at most one hidden interval of the final change.
    await act(async () => {
      timers.advanceTimersByTime(intervalMs)
      await flushMicrotasks()
    })

    const hiddenRefreshes = getEpics.mock.calls.length - callsBeforeHidden
    const maxAllowed = Math.ceil(120 / (intervalMs / 1_000)) + 1
    expect(maxInFlight).toBe(1)
    expect(hiddenRefreshes).toBeGreaterThanOrEqual(1)
    expect(hiddenRefreshes).toBeLessThanOrEqual(maxAllowed)
    expect(seen.current?.epics[0]?.id).toBe(`hidden-change-${totalChanges}`)
  })

  test("slow hidden refreshes never overlap even when requests take several seconds", async () => {
    const intervalMs = getHiddenIntervalMs()
    let latestEpicId = "alpha-initial"
    let inFlight = 0
    let maxInFlight = 0

    setWorkspaceCookie(alpha.id)
    let mounted = false
    const { seen, getEpics } = mountLifecycle({
      treeRequest: () => {
        const snapshot = latestEpicId
        if (!mounted) {
          return Promise.resolve({ success: true as const, epics: [epic(snapshot)] })
        }
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        return new Promise((resolve) => {
          setTimeout(() => {
            inFlight -= 1
            resolve({ success: true as const, epics: [epic(snapshot)] })
          }, 8_000)
        })
      },
    })
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-initial"))
    mounted = true

    timers.useFakeTimers()
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    const callsBeforeHidden = getEpics.mock.calls.length

    // 60 changes over 120s (every 2s) while each RPC takes 8s.
    for (let i = 1; i <= 60; i++) {
      latestEpicId = `slow-change-${i}`
      await act(async () => {
        void seen.current?.loadEpics()
        if (i < 60) {
          timers.advanceTimersByTime(2_000)
        }
        await flushMicrotasks()
      })
    }

    // Advance one interval + the 8s RPC duration so the final scheduled load settles.
    await act(async () => {
      timers.advanceTimersByTime(intervalMs + 8_000)
      await flushMicrotasks()
    })

    const hiddenRefreshes = getEpics.mock.calls.length - callsBeforeHidden
    const maxAllowed = Math.ceil(120 / (intervalMs / 1_000)) + 1
    expect(maxInFlight).toBe(1)
    expect(inFlight).toBe(0)
    expect(hiddenRefreshes).toBeGreaterThanOrEqual(1)
    expect(hiddenRefreshes).toBeLessThanOrEqual(maxAllowed)
    expect(seen.current?.epics[0]?.id).toBe("slow-change-60")
  })

  test("showing the window cancels any pending hidden timer and runs exactly one catch-up", async () => {
    const intervalMs = getHiddenIntervalMs()
    let latestEpicId = "alpha-initial"
    setWorkspaceCookie(alpha.id)
    const { seen, getEpics } = mountLifecycle({
      treeRequest: () => Promise.resolve({ success: true as const, epics: [epic(latestEpicId)] }),
    })
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-initial"))

    timers.useFakeTimers()
    const callsBefore = getEpics.mock.calls.length
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
      latestEpicId = "caught-up-on-show"
      for (let i = 0; i < 15; i++) void seen.current?.loadEpics()
    })
    expect(getEpics.mock.calls.length).toBe(callsBefore)

    // Advance part-way through the hidden window, then show the window.
    await act(async () => {
      timers.advanceTimersByTime(Math.floor(intervalMs / 3))
      await flushMicrotasks()
    })
    expect(getEpics.mock.calls.length).toBe(callsBefore)

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await flushMicrotasks()
    })
    expect(getEpics.mock.calls.length).toBe(callsBefore + 1)
    expect(seen.current?.epics[0]?.id).toBe("caught-up-on-show")

    // Advancing well past the original hidden deadline must not fire a leftover timer.
    await act(async () => {
      timers.advanceTimersByTime(intervalMs * 2)
      await flushMicrotasks()
    })
    expect(getEpics.mock.calls.length).toBe(callsBefore + 1)
  })

  test("switching workspaces while hidden discards the stale in-flight result and loads the new workspace", async () => {
    const intervalMs = getHiddenIntervalMs()
    const pending: Array<{ db?: string; resolve: (value: unknown) => void }> = []
    let mounted = false

    setWorkspaceCookie(alpha.id)
    const { seen } = mountLifecycle({
      treeRequest: (db) => {
        if (!mounted) {
          return Promise.resolve({ success: true as const, epics: [epic("alpha-initial")] })
        }
        return new Promise((resolve) => pending.push({ db, resolve }))
      },
    })
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-initial"))
    mounted = true

    timers.useFakeTimers()
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
      void seen.current?.loadEpics()
    })

    // Advance one hidden interval so alpha's background refresh is actively in flight.
    await act(async () => {
      timers.advanceTimersByTime(intervalMs)
      await flushMicrotasks()
    })
    expect(pending.some((p) => p.db?.includes("alpha"))).toBe(true)

    // Switch to beta while still hidden, then resolve alpha's stale request.
    await act(async () => {
      setWorkspaceCookie(beta.id)
      await flushMicrotasks()
    })
    expect(seen.current?.currentWorkspace?.id).toBe(beta.id)

    await act(async () => {
      pending
        .find((p) => p.db?.includes("alpha"))
        ?.resolve({ success: true, epics: [epic("stale-alpha")] })
      await flushMicrotasks()
    })
    expect(seen.current?.epics.some((e) => e.id === "stale-alpha")).toBe(false)

    // Beta refreshes within one hidden interval without touching alpha again.
    await act(async () => {
      timers.advanceTimersByTime(intervalMs)
      await flushMicrotasks()
    })
    const betaReq = pending.find((p) => p.db?.includes("beta"))
    expect(betaReq).toBeDefined()
    await act(async () => {
      betaReq?.resolve({ success: true, epics: [epic("latest-beta")] })
      await flushMicrotasks()
    })
    expect(seen.current?.epics.map((e) => e.id)).toEqual(["latest-beta"])
  })

  test("a visible refresh that finishes after the window hides defers its dirty follow-up to the hidden interval", async () => {
    const intervalMs = getHiddenIntervalMs()
    const pending: Array<(value: unknown) => void> = []
    let mounted = false

    setWorkspaceCookie(alpha.id)
    const { seen, getEpics } = mountLifecycle({
      treeRequest: () => {
        if (!mounted) {
          return Promise.resolve({ success: true as const, epics: [epic("alpha-initial")] })
        }
        return new Promise((resolve) => pending.push(resolve))
      },
    })
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-initial"))
    mounted = true

    timers.useFakeTimers()
    const callsBefore = getEpics.mock.calls.length

    // Start a visible refresh; while it is in flight, hide the window and mark dirty.
    act(() => {
      void seen.current?.loadEpics()
    })
    expect(pending.length).toBe(1)

    await act(async () => {
      timers.advanceTimersByTime(2_000)
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
      document.dispatchEvent(new Event("visibilitychange"))
      void seen.current?.loadEpics()
      pending[0]?.({ success: true, epics: [epic("mid-flight")] })
      await flushMicrotasks()
    })

    // Must not start a second fetch immediately after settling while hidden.
    expect(getEpics.mock.calls.length).toBe(callsBefore + 1)
    expect(seen.current?.epics[0]?.id).toBe("mid-flight")

    // Advancing the remaining hidden interval starts the single coalesced follow-up.
    await act(async () => {
      timers.advanceTimersByTime(intervalMs - 2_000)
      await flushMicrotasks()
    })
    expect(pending.length).toBe(2)
    await act(async () => {
      pending[1]?.({ success: true, epics: [epic("deferred-follow-up")] })
      await flushMicrotasks()
    })
    expect(seen.current?.epics[0]?.id).toBe("deferred-follow-up")
  })
})
