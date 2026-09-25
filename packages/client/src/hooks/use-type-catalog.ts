import { useCallback, useRef, useState } from "react"
import { rpc } from "@/lib/rpc"
import type { Workspace } from "@/lib/types"

// The workspace's issue-type catalog (`bd types`), kept per workspace so a
// late response for a workspace the user already left cannot replace the
// current one. Extracted from useWorkspaceLifecycle (beadbox-01f.13).

type CatalogState = {
  workspaceId: string
  status: "loading" | "retrying" | "ready" | "error"
  message?: string
}

export function useTypeCatalog(currentWorkspace: Workspace | null) {
  const [availableTypes, setAvailableTypes] = useState<string[]>([])
  const [catalog, setCatalog] = useState<CatalogState | null>(null)
  const requestRef = useRef(0)

  const current = catalog && catalog.workspaceId === currentWorkspace?.id ? catalog : null
  const typeCatalogReady = current?.status === "ready"
  const typeCatalogRetrying = current?.status === "retrying"
  const failed = current?.status === "error" || typeCatalogRetrying
  const typeCatalogError = failed ? (current?.message ?? "Could not load issue types") : null

  const fetchAvailableTypes = useCallback(async (workspace: Workspace, retry = false) => {
    const request = ++requestRef.current
    setCatalog((previous) => ({
      workspaceId: workspace.id,
      status: retry ? "retrying" : "loading",
      message: retry && previous?.workspaceId === workspace.id ? previous.message : undefined,
    }))
    if (!retry) setAvailableTypes([])
    try {
      const types = await rpc.beads.getAvailableTypes(workspace.databasePath)
      if (requestRef.current !== request) return
      setAvailableTypes(types)
      setCatalog({ workspaceId: workspace.id, status: "ready" })
    } catch (error) {
      if (requestRef.current !== request) return
      setAvailableTypes([])
      setCatalog({
        workspaceId: workspace.id,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  const retryAvailableTypes = useCallback(() => {
    if (!currentWorkspace || typeCatalogRetrying) return
    void fetchAvailableTypes(currentWorkspace, true)
  }, [currentWorkspace, typeCatalogRetrying, fetchAvailableTypes])

  /** Drop any in-flight response (called when the workspace changes). */
  const cancelTypeCatalog = useCallback(() => {
    requestRef.current++
  }, [])

  return {
    availableTypes,
    typeCatalogReady,
    typeCatalogRetrying,
    typeCatalogError,
    fetchAvailableTypes,
    retryAvailableTypes,
    cancelTypeCatalog,
  }
}
