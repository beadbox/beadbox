// An unusable workspace registry is set aside by the sidecar, which leaves the
// app with an empty workspace list. Without a word about it the user just sees
// a blank selector (beadbox-4n0, folded into beadbox-x3y).

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

import { StartupGate } from "../components/startup-gate"
import { _setRpc, type RemoteApi } from "../lib/rpc"

const quarantine = {
  registryPath: "/Users/me/.beadbox/registry.json",
  reason: "not valid JSON: Unexpected end of JSON input",
  movedTo: "/Users/me/.beadbox/registry.json.corrupt-1790000000000",
}

function installRpc(registryQuarantine?: typeof quarantine) {
  _setRpc(
    new Proxy(
      {
        health: {
          runStartupHealth: mock(() =>
            Promise.resolve({ hasWorkspaces: false, workspaces: [], platform: "darwin", registryQuarantine }),
          ),
        },
      },
      {
        get: (t, k) =>
          k in t
            ? t[k as keyof typeof t]
            : new Proxy({}, { get: () => mock(() => Promise.resolve({ success: true, data: [] })) }),
      },
    ) as unknown as RemoteApi,
  )
}

function mountGate() {
  const rootRoute = createRootRoute({
    component: () => (
      <StartupGate>
        <Outlet />
      </StartupGate>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <div>HOME</div> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => <div>WORKSPACE SELECTOR</div> }),
  ])
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) })
  render(<RouterProvider router={router as never} />)
}

afterEach(cleanup)

describe("startup gate: an unusable registry is explained, not silently emptied", () => {
  test("shows where the registry went and why, then continues to the selector", async () => {
    installRpc(quarantine)
    mountGate()

    await waitFor(() => expect(screen.getByText("Your workspace list could not be read")).toBeTruthy(), {
      timeout: 5_000,
    })
    const alert = screen.getByRole("alert").textContent ?? ""
    expect(alert).toContain(quarantine.registryPath)
    expect(alert).toContain(quarantine.reason)
    expect(alert).toContain(quarantine.movedTo)
    expect(screen.queryByText("WORKSPACE SELECTOR")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Continue with an empty list" }))
    await waitFor(() => expect(screen.getByText("WORKSPACE SELECTOR")).toBeTruthy(), { timeout: 5_000 })
    expect(screen.queryByText("Your workspace list could not be read")).toBeNull()
  }, 20_000)

  test("control: an empty registry that was never quarantined goes straight to the selector", async () => {
    installRpc(undefined)
    mountGate()
    await waitFor(() => expect(screen.getByText("WORKSPACE SELECTOR")).toBeTruthy(), { timeout: 5_000 })
    expect(screen.queryByText("Your workspace list could not be read")).toBeNull()
  }, 20_000)
})
