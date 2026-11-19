// beadbox-984: useWorkspaceRail.moveWorkspace — the sidebar order.
// The list moves at once; the order is saved through
// rpc.workspaces.setWorkspaceOrder; a saved move announces a registry change
// (so /workspaces and All projects follow); a failed save toasts and re-reads
// the registry, putting the saved order back. Same _setRpc seam and memory
// router as use-workspace-rail.test.tsx.

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

import { useWorkspaceRail, type WorkspaceRailController } from "../hooks/use-workspace-rail"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { WorkspaceCard } from "../lib/types"
import { subscribeWorkspaceRegistryChange } from "../lib/workspace-registry-events"

const card = (id: string): WorkspaceCard => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  databasePath: `/tmp/${id}/.beads`,
  mode: "embedded",
  available: true,
})
const [a, b, c, d] = ["a", "b", "c", "d"].map(card)

type OrderResult = { success: true; order: string[] } | { success: false; error: string }

// The mock registry: a saved order changes what the next read returns, as the
// sidecar's does; a refused or failed save leaves it as it was.
function installRpc(list: WorkspaceCard[], orderResult?: OrderResult | Error) {
  let registry = [...list]
  const mocks = {
    getRegisteredWorkspacesForSelector: mock(() => Promise.resolve([...registry])),
    setWorkspaceOrder: mock((ids: string[]) => {
      if (orderResult instanceof Error) return Promise.reject(orderResult)
      if (orderResult) return Promise.resolve(orderResult)
      registry = ids.map((id) => registry.find((w) => w.id === id) as WorkspaceCard)
      return Promise.resolve({ success: true as const, order: ids })
    }),
  }
  _setRpc({ workspaces: mocks } as unknown as RemoteApi)
  return mocks
}

async function mountRail(list: WorkspaceCard[], orderResult?: OrderResult | Error) {
  const mocks = installRpc(list, orderResult)
  const seen: { current: WorkspaceRailController | null } = { current: null }
  function Probe() {
    seen.current = useWorkspaceRail()
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  render(<RouterProvider router={router as never} />)
  await waitFor(() => expect(seen.current?.workspaces.length).toBe(list.length))
  return { mocks, rail: () => seen.current as WorkspaceRailController }
}

const ids = (list: WorkspaceCard[]) => list.map((w) => w.id)

afterEach(() => {
  cleanup()
  _resetRpc()
})

describe("moveWorkspace", () => {
  test("moves the 4th workspace to the top at once and saves that order", async () => {
    const { mocks, rail } = await mountRail([a, b, c, d])
    let saved: boolean | undefined
    await act(async () => {
      saved = await rail().moveWorkspace(d, 0)
    })
    expect(saved).toBe(true)
    expect(ids(rail().workspaces)).toEqual(["d", "a", "b", "c"])
    expect(mocks.setWorkspaceOrder).toHaveBeenCalledTimes(1)
    expect(mocks.setWorkspaceOrder.mock.calls[0][0]).toEqual(["d", "a", "b", "c"])
  })

  test("moves down by one", async () => {
    const { mocks, rail } = await mountRail([a, b, c])
    await act(async () => {
      await rail().moveWorkspace(a, 1)
    })
    expect(ids(rail().workspaces)).toEqual(["b", "a", "c"])
    expect(mocks.setWorkspaceOrder.mock.calls[0][0]).toEqual(["b", "a", "c"])
  })

  test("a move to the same place saves nothing", async () => {
    const { mocks, rail } = await mountRail([a, b, c])
    let saved: boolean | undefined
    await act(async () => {
      saved = await rail().moveWorkspace(b, 1)
    })
    expect(saved).toBe(false)
    expect(mocks.setWorkspaceOrder).not.toHaveBeenCalled()
  })

  test("a saved move announces a registry change for the other surfaces", async () => {
    const { rail } = await mountRail([a, b, c])
    const heard = mock(() => {})
    const unsubscribe = subscribeWorkspaceRegistryChange(heard)
    try {
      await act(async () => {
        await rail().moveWorkspace(c, 0)
      })
      expect(heard).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  test.each([
    ["the sidecar refuses it", { success: false as const, error: "disk full" }],
    ["the call throws", new Error("sidecar gone")],
  ])("when %s, the list goes back to the saved order", async (_label, result) => {
    const { mocks, rail } = await mountRail([a, b, c], result)
    const heard = mock(() => {})
    const unsubscribe = subscribeWorkspaceRegistryChange(heard)
    try {
      let saved: boolean | undefined
      await act(async () => {
        saved = await rail().moveWorkspace(c, 0)
      })
      expect(saved).toBe(false)
      // Re-read from the registry (the mock still returns a, b, c).
      await waitFor(() => expect(ids(rail().workspaces)).toEqual(["a", "b", "c"]))
      expect(mocks.getRegisteredWorkspacesForSelector.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(heard).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })
})
