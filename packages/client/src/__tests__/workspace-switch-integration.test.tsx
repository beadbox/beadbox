// Switching projects end to end: StartupGate + useWorkspaceLifecycle, driven
// the way the workspace rail drives them (a cookie write via
// lib/workspace-actions.activateWorkspace).
//
// The contract under test is what the user sees: home-page renders the epic
// skeleton exactly while `isLoading && !hasExistingDataRef.current`, so this
// harness reports that expression per click. A workspace visited earlier in
// the session must never show the skeleton again.

import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"

import { StartupGate, useWorkspaceGate } from "../components/startup-gate"
import type { AppHealth } from "../hooks/use-app-health"
import { useWorkspaceLifecycle } from "../hooks/use-workspace-lifecycle"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { Epic, Workspace } from "../lib/types"
import { activateWorkspace } from "../lib/workspace-actions"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

const home: Workspace = {
  id: "3f1b8a24-0000-4000-8000-0000000000ff",
  name: "home-project",
  path: "/tmp/home-project",
  databasePath: "/tmp/home-project/.beads",
  mode: "embedded",
}

const alpha: Workspace = {
  id: "3f1b8a24-0000-4000-8000-00000000a001",
  name: "demo-alpha",
  path: "/tmp/demo-alpha",
  databasePath: "/tmp/demo-alpha/.beads",
  mode: "embedded",
}

const beta: Workspace = {
  id: "3f1b8a24-0000-4000-8000-00000000b002",
  name: "demo-beta",
  path: "/tmp/demo-beta",
  databasePath: "/tmp/demo-beta/.beads",
  mode: "embedded",
}

function epic(id: string): Epic {
  return { id, type: "epic", title: id, children: [] } as unknown as Epic
}

const EPICS_BY_DB: Record<string, Epic[]> = {
  [home.databasePath as string]: [epic("home-1")],
  [alpha.databasePath as string]: [epic("alpha-1")],
  [beta.databasePath as string]: [epic("beta-1")],
}

// The sidecar resolves a workspace's databasePath two different ways:
// runStartupHealth uses resolveBdDbPath ("<project>/.beads/beads.db") while
// getWorkspaces uses resolveLocalEntry ("<project>/.beads"). Both spellings
// reach the client, so the fixtures reproduce both.
function healthSpelling(workspace: Workspace): Workspace {
  return { ...workspace, databasePath: `${workspace.databasePath}/beads.db` }
}

function installRpc(registry: Workspace[] = [alpha, beta], failTypesFor: string[] = []) {
  const getEpics = mock((dbPath?: string, includeSystem?: boolean) => {
    // bd is happy with either spelling; normalize so the fixture answers both.
    const key = (dbPath ?? "").replace(/\/beads\.db$/, "")
    const regular = EPICS_BY_DB[key] ?? []
    return Promise.resolve({
      success: true as const,
      epics: includeSystem ? [...regular, epic("system-gate")] : regular,
    })
  })
  const runStartupHealth = mock((cookieId?: string) => {
    const target = registry.find((w) => w.id === cookieId) ?? registry[0]
    return Promise.resolve({
      platform: "darwin",
      hasWorkspaces: true,
      workspaces: registry.map(healthSpelling),
      activeWorkspaceId: target.id,
      healthCheck: { ok: true as const },
      bdVersion: "1.2.2",
      bdPath: "/opt/homebrew/bin/bd",
    })
  })
  _setRpc({
    health: { runStartupHealth },
    epics: { getEpics },
    workspaces: {
      getWorkspaces: mock(() => Promise.resolve(registry)),
      setActiveWorkspaceAction: mock((_databasePath: string) => Promise.resolve()),
    },
    beads: {
      getAvailableStatuses: mock(() => Promise.resolve(["open", "in_progress", "closed"])),
      getCustomStatusList: mock(() => Promise.resolve([])),
      getAvailableTypes: mock((dbPath?: string) =>
        failTypesFor.some((path) => dbPath?.includes(path))
          ? Promise.reject(new Error("bd types failed"))
          : Promise.resolve(["task", "decision"]),
      ),
    },
  } as unknown as RemoteApi)
  return { getEpics, runStartupHealth }
}

const healthy: AppHealth = { status: "healthy" }

function Probe() {
  const { workspaces } = useWorkspaceGate()
  const lifecycle = useWorkspaceLifecycle({
    initialWorkspaces: workspaces,
    appHealth: healthy,
    appHealthRef: { current: healthy },
    setHealthy: () => {},
    setDegraded: () => {},
    setHealthError: () => {},
    setFatal: () => {},
  })
  // Exactly home-page's skeleton condition.
  const skeleton = lifecycle.isLoading && !lifecycle.hasExistingDataRef.current
  return (
    <>
      <span data-testid="probe">
        {`${lifecycle.currentWorkspace?.name ?? "none"}|${skeleton ? "skeleton" : "tree"}|${lifecycle.epics
          .map((e) => e.id)
          .join(",")}`}
      </span>
      <span data-testid="catalog">
        {lifecycle.typeCatalogError ?? (lifecycle.typeCatalogReady ? "ready" : "loading")}
      </span>
      <button type="button" onClick={() => lifecycle.setIncludeSystem(!lifecycle.includeSystem)}>
        Toggle system issues
      </button>
    </>
  )
}

function mountApp() {
  const rootRoute = createRootRoute({
    component: () => (
      <StartupGate>
        <Probe />
        <Outlet />
      </StartupGate>
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

/** Snapshot of what the user is looking at, or the gate's own screen. */
function view(): string {
  const probe = screen.queryByTestId("probe")
  if (!probe) return document.body.textContent?.includes("Starting up") ? "starting-up" : "gone"
  return probe.textContent ?? ""
}

async function clickTab(workspace: Workspace) {
  await act(async () => {
    await activateWorkspace(workspace)
  })
  // Let the gate settle (it may re-check) and the epics load resolve.
  await waitFor(() => {
    expect(view()).toContain(workspace.name)
  })
}

afterEach(() => {
  cleanup()
  _resetRpc()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
  localStorage.removeItem(`beadbox:system-issues:${alpha.id}`)
  localStorage.removeItem(`beadbox:system-issues:${beta.id}`)
})

describe("workspace switching (gate + lifecycle)", () => {
  test("type catalog failure is visible and clears on workspace switch", async () => {
    setWorkspaceCookie(alpha.id)
    installRpc([alpha, beta], ["demo-alpha"])
    mountApp()
    await waitFor(() => expect(screen.getByTestId("catalog").textContent).toBe("bd types failed"))
    await clickTab(beta)
    await waitFor(() => expect(screen.getByTestId("catalog").textContent).toBe("ready"))
  })

  test("system mode is scoped to workspace and does not reuse the normal tree", async () => {
    setWorkspaceCookie(alpha.id)
    const { getEpics } = installRpc()
    mountApp()
    await waitFor(() => expect(view()).toBe("demo-alpha|tree|alpha-1"))

    await act(async () => {
      screen.getByRole("button", { name: "Toggle system issues" }).click()
    })
    await waitFor(() => expect(view()).toBe("demo-alpha|tree|alpha-1,system-gate"))
    expect(getEpics.mock.calls.some((call) => call[1] === true)).toBe(true)

    await clickTab(beta)
    await waitFor(() => expect(view()).toBe("demo-beta|tree|beta-1"))
    await clickTab(alpha)
    await waitFor(() => expect(view()).toBe("demo-alpha|tree|alpha-1,system-gate"))
  })

  test("a workspace visited earlier in the session never shows the skeleton again", async () => {
    setWorkspaceCookie(alpha.id)
    installRpc()
    mountApp()

    // First paint of alpha: nothing cached, skeleton is correct.
    await waitFor(() => {
      expect(view()).toBe("demo-alpha|tree|alpha-1")
    })

    // First visit to beta: still a cold load.
    await clickTab(beta)
    await waitFor(() => {
      expect(view()).toBe("demo-beta|tree|beta-1")
    })

    // Second visit to alpha — this is the click the user reported as still
    // showing the placeholder.
    const seen: string[] = []
    await act(async () => {
      await activateWorkspace(alpha)
    })
    seen.push(view())
    await waitFor(() => {
      expect(view()).toBe("demo-alpha|tree|alpha-1")
    })
    expect(seen).not.toContain("starting-up")
    expect(seen.join("|")).not.toContain("skeleton")

    // Second visit to beta.
    const seenBeta: string[] = []
    await act(async () => {
      await activateWorkspace(beta)
    })
    seenBeta.push(view())
    await waitFor(() => {
      expect(view()).toBe("demo-beta|tree|beta-1")
    })
    expect(seenBeta).not.toContain("starting-up")
    expect(seenBeta.join("|")).not.toContain("skeleton")
  })
})

describe("workspace switching after adding projects mid-session", () => {
  test("the second visit to a freshly added workspace paints from cache", async () => {
    // The app booted on an existing project; demo-alpha / demo-beta were added
    // from the rail while it was running, so the gate's list already contains
    // them (the rail's add triggers a registry read) but neither has been
    // health-checked yet.
    setWorkspaceCookie(home.id)
    installRpc([home, alpha, beta])
    mountApp()

    await waitFor(() => {
      expect(view()).toBe("home-project|tree|home-1")
    })

    await clickTab(alpha) // cold
    await clickTab(beta) // cold

    const seenAlpha: string[] = []
    await act(async () => {
      await activateWorkspace(alpha)
    })
    seenAlpha.push(view())
    await waitFor(() => {
      expect(view()).toBe("demo-alpha|tree|alpha-1")
    })
    expect(seenAlpha.join("|")).not.toContain("skeleton")
    expect(seenAlpha).not.toContain("starting-up")

    const seenBeta: string[] = []
    await act(async () => {
      await activateWorkspace(beta)
    })
    seenBeta.push(view())
    await waitFor(() => {
      expect(view()).toBe("demo-beta|tree|beta-1")
    })
    expect(seenBeta.join("|")).not.toContain("skeleton")
    expect(seenBeta).not.toContain("starting-up")
  })
})
