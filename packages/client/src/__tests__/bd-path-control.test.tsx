import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { SettingsDialog } from "../components/settings-dialog"
import { StartupGate } from "../components/startup-gate"
import { BdMissingScreen } from "../components/workspaces-page"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { Workspace } from "../lib/types"
import { clearWorkspaceCookie } from "../lib/workspace-cookie"

afterEach(() => {
  cleanup()
  _resetRpc()
  clearWorkspaceCookie()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

function makeInfo(overrides: Record<string, unknown> = {}) {
  return {
    effectivePath: "/Users/alice/.local/share/mise/shims/bd",
    source: "auto" as const,
    envPath: null,
    savedPath: null,
    bdAvailable: true,
    bdVersion: "1.3.4",
    minVersion: "1.1.0",
    platform: "darwin",
    statusError: null,
    statusErrorCode: null,
    ...overrides,
  }
}

function renderSettings() {
  return render(
    <SettingsDialog
      open
      onOpenChange={() => {}}
      theme="gray"
      onThemeChange={() => {}}
      zoomLevel={100}
      onZoomChange={() => {}}
      vimNavigationEnabled
      onVimNavigationChange={() => {}}
      updateCheckEnabled
      onUpdateCheckEnabledChange={() => {}}
      updateCheckFrequency={3600000}
      onUpdateCheckFrequencyChange={() => {}}
      updateAvailable={null}
      updateChecking={false}
      updateCheckError={null}
      onCheckForUpdates={async () => {}}
    />,
  )
}

describe("SettingsDialog — bd path configuration", () => {
  test("shows winning source, saves custom path with spaces, and resets to automatic detection", async () => {
    let currentInfo = makeInfo()
    const setBdPathMock = mock(async (nextPath: string | null) => {
      if (nextPath === null) {
        currentInfo = makeInfo({ source: "auto", savedPath: null })
        return { ok: true as const, info: currentInfo }
      }
      if (nextPath === "/bad/bd") {
        return {
          ok: false as const,
          code: "not_found" as const,
          error: "No file found at /bad/bd.",
        }
      }
      currentInfo = makeInfo({
        effectivePath: nextPath,
        source: "saved",
        savedPath: nextPath,
        bdVersion: "1.3.5",
      })
      return { ok: true as const, info: currentInfo }
    })

    _setRpc({
      system: {
        getLogDirectory: async () => "/tmp/logs",
      },
      health: {
        getBdPathInfo: async () => currentInfo,
        setBdPath: setBdPathMock,
      },
    } as unknown as RemoteApi)

    renderSettings()

    await waitFor(() => {
      expect(screen.getByText("Automatic detection")).toBeTruthy()
      expect(screen.getByText("/Users/alice/.local/share/mise/shims/bd")).toBeTruthy()
    })

    const input = screen.getByLabelText("Custom bd executable path") as HTMLInputElement

    // Validation failure surfaces inline alert
    fireEvent.change(input, { target: { value: "/bad/bd" } })
    fireEvent.click(screen.getByRole("button", { name: "Save bd path" }))
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("No file found at /bad/bd.")
    })

    // Valid path with spaces succeeds and switches winning source to Custom path
    const spaced = "/Applications/My Tools/bd"
    fireEvent.change(input, { target: { value: spaced } })
    fireEvent.click(screen.getByRole("button", { name: "Save bd path" }))
    await waitFor(() => {
      expect(setBdPathMock).toHaveBeenCalledWith(spaced)
      expect(screen.getByText("Custom path")).toBeTruthy()
      expect(screen.getByText(spaced)).toBeTruthy()
    })

    // Reset to automatic detection clears saved path
    fireEvent.click(screen.getByRole("button", { name: "Use automatic detection" }))
    await waitFor(() => {
      expect(setBdPathMock).toHaveBeenCalledWith(null)
      expect(screen.getByText("Automatic detection")).toBeTruthy()
    })
  })

  test("shows when BD_PATH environment variable overrides a saved path", async () => {
    _setRpc({
      system: {
        getLogDirectory: async () => "/tmp/logs",
      },
      health: {
        getBdPathInfo: async () =>
          makeInfo({
            effectivePath: "/env/override/bd",
            source: "env",
            envPath: "/env/override/bd",
            savedPath: "/saved/custom/bd",
          }),
        setBdPath: async () => ({ ok: true as const, info: makeInfo() }),
      },
    } as unknown as RemoteApi)

    renderSettings()

    await waitFor(() => {
      expect(screen.getByText("BD_PATH environment variable")).toBeTruthy()
      expect(screen.getByText("/env/override/bd")).toBeTruthy()
      expect(screen.getByRole("button", { name: "Use automatic detection" })).toBeTruthy()
    })
  })
})

describe("StartupGate & WorkspacesPage — bd path configuration on missing/too-old screens", () => {
  const ws: Workspace = {
    id: "3f1b8a24-0000-4000-8000-00000000d099",
    name: "alpha",
    path: "/tmp/alpha",
    databasePath: "/tmp/alpha/.beads",
    mode: "embedded",
  }

  test("StartupGate too-old screen lets user set bd path or reset to auto and retries startup health", async () => {
    let healthy = false
    const runStartupHealth = mock(async () => {
      if (!healthy) {
        return {
          platform: "linux",
          hasWorkspaces: true,
          workspaces: [ws],
          activeWorkspaceId: ws.id,
          healthCheck: {
            ok: false as const,
            error: { kind: "bd_version_too_old" as const, current: "1.0.4", required: "1.1.0" },
          },
        }
      }
      return {
        platform: "linux",
        hasWorkspaces: true,
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        bdVersion: "1.3.4",
        bdPath: "/custom/mise/bd",
        healthCheck: { ok: true as const, bdVersion: "1.3.4", bdPath: "/custom/mise/bd" },
      }
    })

    const setBdPathMock = mock(async (nextPath: string | null) => {
      healthy = true
      return {
        ok: true as const,
        info: makeInfo({
          platform: "linux",
          effectivePath: nextPath ?? "/auto/bd",
          source: nextPath ? "saved" : "auto",
          savedPath: nextPath,
        }),
      }
    })

    _setRpc({
      health: {
        runStartupHealth,
        getBdPathInfo: async () =>
          makeInfo({
            platform: "linux",
            effectivePath: "/usr/bin/bd",
            source: "saved",
            savedPath: "/usr/bin/bd",
            bdVersion: "1.0.4",
            statusErrorCode: "version_too_old",
            statusError: "bd v1.1.0 or later is required (found v1.0.4).",
          }),
        setBdPath: setBdPathMock,
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
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => <div>Workspace Ready</div>,
      }),
      createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
    ])
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })

    const { container } = render(<RouterProvider router={router as never} />)

    await waitFor(() => {
      expect(screen.getByText("bd v1.1.0 or later is required. You have v1.0.4.")).toBeTruthy()
      expect(screen.getByRole("button", { name: "Use automatic detection" })).toBeTruthy()
    })
    // Non-macOS never mentions brew
    expect(container.textContent).not.toContain("brew")

    const input = screen.getByLabelText("Custom bd executable path")
    fireEvent.change(input, { target: { value: "/custom/mise/bd" } })
    fireEvent.click(screen.getByRole("button", { name: "Save bd path" }))

    await waitFor(() => {
      expect(setBdPathMock).toHaveBeenCalledWith("/custom/mise/bd")
      expect(screen.getByText("Workspace Ready")).toBeTruthy()
    })
  })

  test("WorkspacesPage BdMissingScreen lets first-run user configure bd path and triggers re-check", async () => {
    const onCheckAgain = mock(() => {})
    const setBdPathMock = mock(async (nextPath: string | null) => ({
      ok: true as const,
      info: makeInfo({
        platform: "linux",
        effectivePath: nextPath ?? "/auto/bd",
        source: nextPath ? "saved" : "auto",
        savedPath: nextPath,
      }),
    }))

    _setRpc({
      health: {
        getBdPathInfo: async () =>
          makeInfo({
            platform: "linux",
            effectivePath: "bd",
            bdAvailable: false,
            bdVersion: null,
          }),
        setBdPath: setBdPathMock,
      },
    } as unknown as RemoteApi)

    const { container } = render(
      <BdMissingScreen onCheckAgain={onCheckAgain} feedback={null} platform="linux" />,
    )

    await waitFor(() => {
      expect(screen.getByLabelText("Custom bd executable path")).toBeTruthy()
    })
    expect(container.textContent).not.toContain("brew")

    fireEvent.change(screen.getByLabelText("Custom bd executable path"), {
      target: { value: "/home/alice/.local/share/mise/shims/bd" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save bd path" }))

    await waitFor(() => {
      expect(setBdPathMock).toHaveBeenCalledWith("/home/alice/.local/share/mise/shims/bd")
      expect(onCheckAgain).toHaveBeenCalledTimes(1)
    })
  })
})
