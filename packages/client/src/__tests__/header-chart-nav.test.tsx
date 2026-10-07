// Header — Chart tab (PR #51): sits after Formulas, opens /chart, and
// shows as active there.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { Header } from "../components/header"
import type { Workspace } from "../lib/types"

afterEach(cleanup)

const workspace: Workspace = {
  id: "id-alpha",
  name: "alpha",
  path: "/tmp/alpha",
  databasePath: "/tmp/alpha/.beads",
  mode: "embedded",
}

function renderAt(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Header currentWorkspace={workspace} />
        <Outlet />
      </>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>BEADS</p> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/chart", component: () => <p>CHART</p> }),
  ])
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

const tabs = () =>
  screen
    .getAllByRole("button")
    .map((b) => b.textContent?.trim())
    .filter((t) => ["Beads", "Activity", "Formulas", "Chart"].includes(t ?? ""))

describe("Header Chart tab", () => {
  test("comes right after Formulas", async () => {
    renderAt("/")
    await screen.findByText("BEADS")
    expect(tabs()).toEqual(["Beads", "Activity", "Formulas", "Chart"])
  })

  test("clicking it opens the Chart view and marks the tab active", async () => {
    renderAt("/")
    await screen.findByText("BEADS")
    const chart = screen.getByRole("button", { name: "Chart" })
    expect(chart.className).not.toContain("bg-accent text-foreground")
    fireEvent.click(chart)
    expect(await screen.findByText("CHART")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Chart" }).className).toContain("bg-accent text-foreground")
  })
})
