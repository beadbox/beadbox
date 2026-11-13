// useWorkspaceLifecycle — in-place workspace switches.
//
// Two behaviours the workspace rail depends on:
//   1. A cookie write switches the active workspace without a remount
//      (StartupGate skips its re-check for verified workspaces, so nothing
//      else would notice).
//   2. Switching back to a workspace loaded earlier in the session paints
//      its cached tree immediately — hasExistingDataRef stays true, which is
//      what suppresses home-page's skeleton while the refresh runs.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
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

afterEach(() => {
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

// Advance long background-admission delays (the first starts just under 30s
// after the preceding visible request); router/DOM/slow-load timers stay real.
function hiddenClock() {
  let now = Date.now()
  let id = 0
  const timers = new Map<number, { due: number; run: () => void }>()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const date = spyOn(Date, "now").mockImplementation(() => now)
  // Plain wrappers keep Testing Library from mistaking this selective clock
  // for Jest's fake timers (it inspects setTimeout._isMockFunction).
  globalThis.setTimeout = ((run: () => void, ms: number, ...args: unknown[]) => {
    if (ms < 20_000 || ms > 30_000) return realSet(run, ms, ...args)
    const key = --id
    timers.set(key, { due: now + ms, run })
    return key
  }) as typeof setTimeout
  globalThis.clearTimeout = ((key: number) => {
    if (!timers.delete(key)) realClear(key)
  }) as typeof clearTimeout
  return {
    pending: () => timers.size,
    advance: async (ms: number) => {
      now += ms
      await act(async () => {
        for (const [key, timer] of [...timers]) {
          if (timer.due <= now) {
            timers.delete(key)
            timer.run()
          }
        }
      })
    },
    restore: () => {
      cleanup()
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
      date.mockRestore()
      Reflect.deleteProperty(document, "visibilityState")
    },
  }
}

function hide() {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
  document.dispatchEvent(new Event("visibilitychange"))
}

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

  test("hidden changes wait for the cap and showing runs one catch-up", async () => {
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

  test("hidden bursts refresh every 30 seconds with latest data and no idle polling", async () => {
    setWorkspaceCookie(alpha.id)
    let newest = "initial"
    const { seen, getEpics } = mountLifecycle({
      treeRequest: async () => ({ success: true, epics: [epic(newest)] }),
    })
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("initial"))
    const count = getEpics.mock.calls.length
    const clock = hiddenClock()
    try {
      act(hide)
      for (let interval = 1; interval <= 4; interval++) {
        act(() => {
          for (let n = 0; n < 50; n++) {
            newest = `latest-${interval}-${n}`
            void seen.current?.loadEpics()
          }
        })
        expect(clock.pending()).toBe(1)
        expect(getEpics.mock.calls.length).toBe(count + interval - 1)
        await clock.advance(30_000)
        expect(seen.current?.epics[0]?.id).toBe(newest)
        expect(getEpics.mock.calls.length).toBe(count + interval)
      }
      await clock.advance(30_000)
      expect(getEpics.mock.calls.length).toBe(count + 4)
      expect(clock.pending()).toBe(0)
    } finally {
      clock.restore()
    }
  })

  test("a slow hidden request never overlaps and coalesces a latest follow-up", async () => {
    setWorkspaceCookie(alpha.id)
    const { seen, getEpics, release } = mountLifecycle({ deferAfter: 1 })
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-1"))
    const count = getEpics.mock.calls.length
    const clock = hiddenClock()
    try {
      act(() => {
        hide()
        void seen.current?.loadEpics()
      })
      await clock.advance(30_000)
      expect(getEpics.mock.calls.length).toBe(count + 1)
      act(() => {
        for (let n = 0; n < 50; n++) void seen.current?.loadEpics()
      })
      await clock.advance(30_000)
      expect(getEpics.mock.calls.length).toBe(count + 1)
      await act(async () => release())
      // Already waited an interval: one latest follow-up can now start.
      expect(getEpics.mock.calls.length).toBe(count + 2)
      await act(async () => release())
      await clock.advance(30_000)
      expect(getEpics.mock.calls.length).toBe(count + 2)
    } finally {
      clock.restore()
    }
  })

  test("a hidden follow-up waits out the cap even when the request finishes early", async () => {
    setWorkspaceCookie(alpha.id)
    const { seen, getEpics, release } = mountLifecycle({ deferAfter: 1 })
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-1"))
    const count = getEpics.mock.calls.length
    const clock = hiddenClock()
    try {
      act(() => {
        hide()
        void seen.current?.loadEpics()
      })
      await clock.advance(30_000)
      expect(getEpics.mock.calls.length).toBe(count + 1)
      act(() => {
        for (let n = 0; n < 50; n++) void seen.current?.loadEpics()
      })
      await act(async () => release())
      expect(getEpics.mock.calls.length).toBe(count + 1)
      expect(clock.pending()).toBe(1)
      await clock.advance(29_999)
      expect(getEpics.mock.calls.length).toBe(count + 1)
      await clock.advance(1)
      expect(getEpics.mock.calls.length).toBe(count + 2)
      await act(async () => release())
    } finally {
      clock.restore()
    }
  })

  test("a workspace opened while hidden loads within the background interval", async () => {
    setWorkspaceCookie(alpha.id)
    const clock = hiddenClock()
    try {
      act(hide)
      const { seen, getEpics } = mountLifecycle()
      await waitFor(() => expect(seen.current?.currentWorkspace?.id).toBe(alpha.id))
      expect(getEpics.mock.calls.length).toBe(0)
      await clock.advance(30_000)
      expect(getEpics.mock.calls.length).toBe(1)
      expect(seen.current?.epics[0]?.id).toBe("alpha-1")
    } finally {
      clock.restore()
    }
  })

  test("show runs exactly one catch-up even after background data caught up", async () => {
    setWorkspaceCookie(alpha.id)
    const { seen, getEpics } = mountLifecycle()
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-1"))
    const count = getEpics.mock.calls.length
    const clock = hiddenClock()
    try {
      act(() => {
        hide()
        void seen.current?.loadEpics()
      })
      await clock.advance(30_000)
      expect(getEpics.mock.calls.length).toBe(count + 1)
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      await act(async () => document.dispatchEvent(new Event("visibilitychange")))
      expect(getEpics.mock.calls.length).toBe(count + 2)
      await act(async () => document.dispatchEvent(new Event("visibilitychange")))
      await clock.advance(30_000)
      expect(getEpics.mock.calls.length).toBe(count + 2)
    } finally {
      clock.restore()
    }
  })

  test("show cancels the hidden timer and unmount leaves no refresh behind", async () => {
    setWorkspaceCookie(alpha.id)
    const { seen, getEpics } = mountLifecycle()
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-1"))
    const count = getEpics.mock.calls.length
    const clock = hiddenClock()
    try {
      act(() => {
        hide()
        void seen.current?.loadEpics()
      })
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      await act(async () => document.dispatchEvent(new Event("visibilitychange")))
      expect(getEpics.mock.calls.length).toBe(count + 1)
      expect(clock.pending()).toBe(0)
      act(() => {
        hide()
        void seen.current?.loadEpics()
      })
      expect(clock.pending()).toBe(1)
      cleanup()
      expect(clock.pending()).toBe(0)
      await clock.advance(30_000)
      expect(getEpics.mock.calls.length).toBe(count + 1)
    } finally {
      clock.restore()
    }
  })

  test("a hidden workspace switch rejects an old background reply", async () => {
    setWorkspaceCookie(alpha.id)
    const pending: Array<{ db?: string; resolve: (value: unknown) => void }> = []
    let defer = false
    const { seen } = mountLifecycle({
      treeRequest: (db) =>
        defer
          ? new Promise((resolve) => pending.push({ db, resolve }))
          : Promise.resolve({ success: true, epics: [epic("alpha-1")] }),
    })
    await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("alpha-1"))
    const clock = hiddenClock()
    try {
      defer = true
      act(() => {
        hide()
        void seen.current?.loadEpics()
      })
      await clock.advance(30_000)
      expect(pending.length).toBe(1)
      await act(async () => setWorkspaceCookie(beta.id))
      await act(async () => pending[0].resolve({ success: true, epics: [epic("stale-alpha")] }))
      expect(seen.current?.epics.some((e) => e.id === "stale-alpha")).toBe(false)
      await clock.advance(30_000)
      expect(pending.at(-1)?.db).toContain("beta")
      await act(async () => pending.at(-1)?.resolve({ success: true, epics: [epic("latest-beta")] }))
      expect(seen.current?.epics[0]?.id).toBe("latest-beta")
    } finally {
      clock.restore()
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
