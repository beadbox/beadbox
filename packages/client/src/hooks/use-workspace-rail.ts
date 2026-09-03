// State + side effects for the left workspace rail (components/workspace-rail.tsx).
//
// Registry ownership: the rail reads the registry directly via
// rpc.workspaces.getRegisteredWorkspacesForSelector() — the same cheap
// call /workspaces uses (registry read + a databaseExists() stat per
// entry, no bd spawn). It deliberately does NOT read StartupGate's
// WorkspaceGateContext: the rail renders OUTSIDE the gate so it stays on
// screen while the gate re-runs its health check during a workspace
// switch. Reading the gate context would put the rail inside the
// children the gate replaces with its spinner/error screens.
//
// Switching contract: writing the workspace cookie is the switch (see
// lib/workspace-actions.ts). The cookie write publishes, and every mounted
// surface re-resolves from it: StartupGate re-runs its health check for a
// workspace it has not verified this session (which unmounts and remounts
// the route), and adopts the switch silently for one it has — in which
// case the pages pick it up from the same cookie event. Nothing here
// reaches into page state.

import { useNavigate, useRouterState } from "@tanstack/react-router"
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"
import {
  clampWorkspaceRailWidth,
  getWorkspaceRailCollapsed,
  getWorkspaceRailWidth,
  setWorkspaceRailCollapsed,
  setWorkspaceRailWidth,
} from "@/lib/local-storage"
import { toastError } from "@/lib/notifications"
import { rpc } from "@/lib/rpc"
import { useSubscriptionChangeSignal } from "@/lib/subscribe"
import type { WorkspaceCard } from "@/lib/types"
import { activateWorkspace, unregisterWorkspace } from "@/lib/workspace-actions"
import {
  clearWorkspaceCookie,
  getWorkspaceCookie,
  subscribeWorkspaceCookie,
} from "@/lib/workspace-cookie"
import { publishWorkspaceLabel } from "@/lib/workspace-labels"
import { subscribeWorkspaceRegistryChange } from "@/lib/workspace-registry-events"

const DASHBOARD_ROUTE = "/workspaces"

export interface WorkspaceRailController {
  workspaces: WorkspaceCard[]
  activeWorkspaceId: string | null
  width: number
  collapsed: boolean
  dashboardActive: boolean
  switchingWorkspaceId: string | null
  refresh: () => Promise<void>
  selectWorkspace: (workspace: WorkspaceCard) => Promise<void>
  removeWorkspace: (workspace: WorkspaceCard) => Promise<void>
  /**
   * Rename and/or set the tab emoji. `icon: null` clears the emoji.
   * Resolves false when the registry rejected the label, so the caller can
   * keep its editor open with the user's input intact.
   */
  relabelWorkspace: (
    workspace: WorkspaceCard,
    label: { name?: string; icon?: string | null },
  ) => Promise<boolean>
  openDashboard: () => void
  toggleCollapse: () => void
  startResize: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function useWorkspaceRail(): WorkspaceRailController {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [workspaces, setWorkspaces] = useState<WorkspaceCard[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(getWorkspaceCookie)
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null)
  const [width, setWidth] = useState<number>(getWorkspaceRailWidth)
  const [collapsed, setCollapsed] = useState<boolean>(getWorkspaceRailCollapsed)

  // Latest-value refs so the drag/remove closures don't re-bind on every
  // state change (house pattern: workspaces-page's phaseRef).
  const workspacesRef = useRef(workspaces)
  useEffect(() => {
    workspacesRef.current = workspaces
  }, [workspaces])
  const widthRef = useRef(width)
  useEffect(() => {
    widthRef.current = width
  }, [width])
  // Teardown for an in-flight resize drag, so a cancelled pointer or an
  // unmount mid-drag cannot leave `user-select: none` on <body> and a live
  // pointermove listener behind.
  const endDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => endDragRef.current?.(), [])

  const refresh = useCallback(async () => {
    try {
      setWorkspaces(await rpc.workspaces.getRegisteredWorkspacesForSelector())
    } catch {
      // Sidecar unavailable (browser dev, or mid-restart). Keep the last
      // known list rather than flashing an empty rail.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The active workspace lives in the cookie; mirror every write (ours,
  // /workspaces', StartupGate's activeWorkspaceId sync) into the highlight.
  useEffect(() => subscribeWorkspaceCookie(() => setActiveWorkspaceId(getWorkspaceCookie())), [])

  // A registry membership change from another surface — an add or init on
  // the /workspaces dashboard, or a removal from the beads view — raises no
  // bd change signal, so without this the rail kept a stale list until the
  // next subscription bump happened to arrive.
  useEffect(() => subscribeWorkspaceRegistryChange(() => void refresh()), [refresh])

  // bb-1xi2 replay: a `bd init` / registry edit outside the app shows up as
  // a subscription change signal. Skip the initial 0 — the mount effect
  // above already loaded the list once.
  const subscriptionSignal = useSubscriptionChangeSignal()
  useEffect(() => {
    if (subscriptionSignal === 0) return
    void refresh()
  }, [subscriptionSignal, refresh])

  const openDashboard = useCallback(() => {
    void navigate({ to: DASHBOARD_ROUTE })
  }, [navigate])

  const selectWorkspace = useCallback(
    async (workspace: WorkspaceCard) => {
      if (workspace.id === getWorkspaceCookie()) {
        // Already active: the only meaningful action is leaving the dashboard.
        if (pathname === DASHBOARD_ROUTE) void navigate({ to: "/" })
        return
      }
      setSwitchingWorkspaceId(workspace.id)
      try {
        await activateWorkspace(workspace)
        // Switching from the dashboard opens the workspace; switching from a
        // workspace view keeps the current view (browser-tab semantics).
        if (pathname === DASHBOARD_ROUTE) void navigate({ to: "/" })
      } finally {
        setSwitchingWorkspaceId(null)
      }
    },
    [navigate, pathname],
  )

  const removeWorkspace = useCallback(
    async (workspace: WorkspaceCard) => {
      const result = await unregisterWorkspace(workspace, "rail")
      if (!result.ok) {
        toastError("Could not remove workspace", { description: result.error })
        return
      }
      const remaining = workspacesRef.current.filter((w) => w.id !== workspace.id)
      setWorkspaces(remaining)
      toast.success(`Removed "${workspace.name}" from workspace list`)
      if (getWorkspaceCookie() !== workspace.id) return

      // Removed the active workspace: fall through to the next one, or send
      // the user to the dashboard when nothing is left.
      const next = remaining[0]
      if (!next) {
        clearWorkspaceCookie()
        void navigate({ to: DASHBOARD_ROUTE })
        return
      }
      await activateWorkspace(next)
    },
    [navigate],
  )

  const relabelWorkspace = useCallback(
    async (workspace: WorkspaceCard, label: { name?: string; icon?: string | null }) => {
      let result: Awaited<ReturnType<typeof rpc.workspaces.setWorkspaceLabel>>
      try {
        result = await rpc.workspaces.setWorkspaceLabel(workspace.id, label)
      } catch (error) {
        toastError("Could not update workspace", {
          description: error instanceof Error ? error.message : String(error),
        })
        return false
      }
      if (!result.success) {
        toastError("Could not update workspace", { description: result.error })
        return false
      }
      const { name, icon } = result.workspace
      setWorkspaces((prev) => prev.map((w) => (w.id === workspace.id ? { ...w, name, icon } : w)))
      // Push the accepted label to the surfaces holding their own copy of
      // this workspace (page state → Header). See lib/workspace-labels.ts.
      publishWorkspaceLabel({ workspaceId: workspace.id, name, icon })
      return true
    },
    [],
  )

  const toggleCollapse = useCallback(() => {
    const next = !collapsed
    setCollapsed(next)
    setWorkspaceRailCollapsed(next)
  }, [collapsed])

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    const onMove = (ev: PointerEvent) => {
      setWidth(clampWorkspaceRailWidth(startWidth + ev.clientX - startX))
    }
    const endDrag = () => {
      endDragRef.current = null
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", endDrag)
      window.removeEventListener("pointercancel", endDrag)
      setWorkspaceRailWidth(widthRef.current)
    }
    endDragRef.current = endDrag
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", endDrag)
    window.addEventListener("pointercancel", endDrag)
  }, [])

  return {
    workspaces,
    activeWorkspaceId,
    width,
    collapsed,
    dashboardActive: pathname === DASHBOARD_ROUTE,
    switchingWorkspaceId,
    refresh,
    selectWorkspace,
    removeWorkspace,
    relabelWorkspace,
    openDashboard,
    toggleCollapse,
    startResize,
  }
}
