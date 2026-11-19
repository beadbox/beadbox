// Review (beadbox-dbf): a tree read that was already in flight when the user
// edited must not be painted over the edit. Before 3bf49e9 the reload every
// mutation issues superseded the in-flight read (generation bump); the
// coalesced loadEpics joins it instead, so the pre-edit tree is applied.
import { afterEach, expect, mock, test } from "bun:test"
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
const epic = (id: string): Epic => ({ id, type: "epic", title: id, children: [] }) as unknown as Epic

afterEach(() => {
  cleanup()
  _resetRpc()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
})

test("review: an in-flight pre-edit tree read does not overwrite a local edit", async () => {
  setWorkspaceCookie(alpha.id)
  const pending: Array<(value: unknown) => void> = []
  const getEpics = mock(() => new Promise((resolve) => pending.push(resolve)))
  _setRpc({
    epics: { getEpics },
    workspaces: {
      getWorkspaces: mock(() => Promise.resolve([alpha])),
      setActiveWorkspaceAction: mock(() => Promise.resolve()),
    },
    beads: {
      getAvailableTypes: mock(() => Promise.resolve(["task"])),
      getAvailableStatuses: mock(() => Promise.resolve(["open", "in_progress", "closed"])),
      getCustomStatusList: mock(() => Promise.resolve([])),
    },
  } as unknown as RemoteApi)
  const seen: { current: ReturnType<typeof useWorkspaceLifecycle> | null } = { current: null }
  const healthy: AppHealth = { status: "healthy" }
  function Probe() {
    seen.current = useWorkspaceLifecycle({
      initialWorkspaces: [alpha],
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  render(<RouterProvider router={router as never} />)

  await waitFor(() => expect(pending.length).toBe(1))
  await act(async () => pending[0]({ success: true, epics: [epic("before-edit")] }))
  await waitFor(() => expect(seen.current?.epics[0]?.id).toBe("before-edit"))

  // A write from elsewhere starts a refresh. bd reads the tree for it now,
  // before the user's own edit below is written.
  act(() => {
    void seen.current?.loadEpics()
  })
  await waitFor(() => expect(pending.length).toBe(2))

  // The user edits a bead: the optimistic tree, then the reload each mutation
  // issues once bd has the write (use-bead-actions: priority, comment, delete,
  // move, archive).
  act(() => {
    seen.current?.setEpics([epic("edited")])
    void seen.current?.loadEpics()
  })

  // The older read answers with the tree from before the edit.
  await act(async () => pending[1]({ success: true, epics: [epic("before-edit")] }))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50))
  })
  expect(seen.current?.epics[0]?.id).toBe("edited")
})
