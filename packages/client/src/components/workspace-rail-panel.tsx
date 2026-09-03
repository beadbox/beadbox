// Container for the left workspace rail: wires useWorkspaceRail to the
// rail UI plus the add / init / remove-confirm dialogs reused from the
// /workspaces dashboard.
//
// Mounted in routes/__root.tsx OUTSIDE StartupGate so the rail survives
// the gate's re-check spinner during a workspace switch. Hidden below the
// md breakpoint (< 768px) — the mobile layout is single-panel and the
// header's workspace button already reaches the dashboard.

import { useCallback, useState } from "react"
import { useViewport } from "../hooks/use-viewport"
import { useWorkspaceRail } from "../hooks/use-workspace-rail"
import { getAnalyticsEnabled } from "../lib/local-storage"
import { safeCapture } from "../lib/posthog-safe"
import { isTauriRuntime } from "../lib/rpc"
import type { WorkspaceCard } from "../lib/types"
import { AddWorkspaceDialog } from "./add-workspace-dialog"
import { InitWorkspaceDialog } from "./init-workspace-dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog"
import { WorkspaceRail } from "./workspace-rail"

export function WorkspaceRailPanel() {
  // The viewport gate lives in this outer component so the rail's hook —
  // which fetches the registry on mount and subscribes to change signals —
  // is not mounted at all on a phone-width layout.
  const { isMobileLayout } = useViewport()
  if (isMobileLayout) return null
  return <WorkspaceRailShell />
}

function WorkspaceRailShell() {
  const {
    workspaces,
    activeWorkspaceId,
    width,
    collapsed,
    dashboardActive,
    switchingWorkspaceId,
    refresh,
    selectWorkspace,
    removeWorkspace,
    relabelWorkspace,
    openDashboard,
    toggleCollapse,
    startResize,
  } = useWorkspaceRail()
  const [addOpen, setAddOpen] = useState(false)
  const [initOpen, setInitOpen] = useState(false)
  const [initPath, setInitPath] = useState<string | undefined>()
  const [removeTarget, setRemoveTarget] = useState<WorkspaceCard | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)

  const isTauri = isTauriRuntime()

  const handleWorkspacesAdded = useCallback(
    (added: WorkspaceCard[]) => {
      if (getAnalyticsEnabled()) {
        for (const ws of added) {
          safeCapture("app_workspace_added", {
            method: ws.mode === "server" ? "server" : "local",
            success: true,
          })
        }
      }
      void refresh()
    },
    [refresh],
  )

  const handleNeedsInit = useCallback((path: string) => {
    setAddOpen(false)
    setInitPath(path)
    setInitOpen(true)
  }, [])

  const handleInitSuccess = useCallback(() => {
    setInitOpen(false)
    if (getAnalyticsEnabled()) {
      safeCapture("app_workspace_added", { method: "init", success: true })
    }
    void refresh()
  }, [refresh])

  const confirmRemove = useCallback(async () => {
    if (!removeTarget || isRemoving) return
    setIsRemoving(true)
    try {
      await removeWorkspace(removeTarget)
      setRemoveTarget(null)
    } finally {
      setIsRemoving(false)
    }
  }, [removeWorkspace, removeTarget, isRemoving])

  return (
    <>
      <WorkspaceRail
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        width={width}
        collapsed={collapsed}
        dashboardActive={dashboardActive}
        switchingWorkspaceId={switchingWorkspaceId}
        onDashboard={openDashboard}
        onSelect={selectWorkspace}
        onRemove={setRemoveTarget}
        onRelabel={relabelWorkspace}
        onAdd={() => setAddOpen(true)}
        onToggleCollapse={toggleCollapse}
        onResizePointerDown={startResize}
      />

      <AddWorkspaceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onWorkspaceAdded={handleWorkspacesAdded}
        onNeedsInit={handleNeedsInit}
        isTauri={isTauri}
      />

      <InitWorkspaceDialog
        open={initOpen}
        onOpenChange={setInitOpen}
        onSuccess={handleInitSuccess}
        initialPath={initPath}
        isTauri={isTauri}
      />

      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open && !isRemoving) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes &quot;{removeTarget?.name}&quot; from your workspace list. The project
              files and .beads data will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove} disabled={isRemoving}>
              {isRemoving ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
