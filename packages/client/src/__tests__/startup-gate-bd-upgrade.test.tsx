// StartupGate — bd install/upgrade instructions are platform-gated.
//
// `brew` must render on macOS only. It has regressed by being the fall-through
// default after the Windows and Linux branches, which hands brew to any other
// platform. Each case renders the real error screen from a health check result.

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
  id: "3f1b8a24-0000-4000-8000-00000000d004",
  name: "delta",
  path: "/tmp/delta",
  databasePath: "/tmp/delta/.beads",
  mode: "embedded",
}

const GO_INSTALL =
  "CGO_ENABLED=1 GOFLAGS=-tags=gms_pure_go go install github.com/steveyegge/beads/cmd/bd@latest"

/** The copyable command block, matched on its whole rendered text ("$ <command>"). */
function commandBlock(command: string) {
  return screen.getByText((_, el) => el?.tagName === "CODE" && el.textContent === `$ ${command}`)
}

type GateError =
  | { kind: "bd_version_too_old"; current: string; required: string }
  | { kind: "bd_missing" }

function mountFailingGate(platform: string, error: GateError) {
  _setRpc({
    health: {
      runStartupHealth: () =>
        Promise.resolve({
          platform,
          hasWorkspaces: true,
          workspaces: [ws],
          activeWorkspaceId: ws.id,
          healthCheck: { ok: false as const, error },
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

const tooOld: GateError = { kind: "bd_version_too_old", current: "1.0.4", required: "1.1.0" }

describe("bd_version_too_old", () => {
  test("names the required and current versions", async () => {
    mountFailingGate("darwin", tooOld)
    await waitFor(() => {
      expect(screen.getByText("bd v1.1.0 or later is required. You have v1.0.4.")).toBeTruthy()
    })
  })

  test("macOS gets brew upgrade", async () => {
    mountFailingGate("darwin", tooOld)
    await waitFor(() => {
      expect(commandBlock("brew upgrade beads")).toBeTruthy()
    })
  })

  test("Linux gets go install and no brew anywhere", async () => {
    const { container } = mountFailingGate("linux", tooOld)
    await waitFor(() => {
      expect(commandBlock(GO_INSTALL)).toBeTruthy()
    })
    expect(container.textContent).not.toContain("brew")
  })

  test.each(["win32", "freebsd", ""])("platform %p gets no brew", async (platform) => {
    const { container } = mountFailingGate(platform, tooOld)
    await waitFor(() => {
      expect(screen.getByText("bd v1.1.0 or later is required. You have v1.0.4.")).toBeTruthy()
    })
    expect(container.textContent).not.toContain("brew")
  })
})

describe("bd_missing", () => {
  test("macOS gets brew install", async () => {
    mountFailingGate("darwin", { kind: "bd_missing" })
    await waitFor(() => {
      expect(commandBlock("brew install beads")).toBeTruthy()
    })
  })

  test.each(["linux", "win32", "freebsd", ""])("platform %p gets no brew", async (platform) => {
    const { container } = mountFailingGate(platform, { kind: "bd_missing" })
    await waitFor(() => {
      expect(screen.getByText(/install the bd command-line tool/)).toBeTruthy()
    })
    expect(container.textContent).not.toContain("brew")
  })
})
