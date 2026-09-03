// Header — workspace glyph contract.
//
// The brand marble is replaced by the workspace's own emoji when one is set
// from the rail, so the active project reads the same in both places. This
// is the app's primary chrome, so the swap is pinned by a test.

import { afterEach, describe, expect, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { cleanup, render, screen } from "@testing-library/react"

import { Header } from "../components/header"
import type { Workspace } from "../lib/types"

afterEach(cleanup)

// Header reads router state (active nav tab), so it needs a router in scope.
function renderHeader(props: Parameters<typeof Header>[0]) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Header {...props} />
        <Outlet />
      </>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  return render(<RouterProvider router={router as never} />)
}

const workspace: Workspace = {
  id: "id-alpha",
  name: "alpha",
  path: "/tmp/alpha",
  databasePath: "/tmp/alpha/.beads",
  mode: "embedded",
}

describe("Header workspace glyph", () => {
  test("renders the Beadbox marble when the workspace has no icon", async () => {
    const { container } = renderHeader({ currentWorkspace: workspace })
    expect(await screen.findByText("alpha")).toBeTruthy()
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0)
    expect(screen.queryByText("🚀")).toBeNull()
  })

  test("renders the workspace emoji when one is set", async () => {
    renderHeader({ currentWorkspace: { ...workspace, icon: "🚀" } })
    expect(await screen.findByText("🚀")).toBeTruthy()
    expect(screen.getByText("alpha")).toBeTruthy()
  })

  test("keeps the loading marble while a workspace load is pending", async () => {
    renderHeader({ currentWorkspace: { ...workspace, icon: "🚀" }, isPending: true })
    expect(await screen.findByText("alpha")).toBeTruthy()
    expect(screen.queryByText("🚀")).toBeNull()
  })
})
