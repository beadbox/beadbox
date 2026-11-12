import { useEffect } from "react"
import type { Filters } from "@/lib/types"

/** Bind saved labels to the resolved workspace, clearing them on switches in any filter view. */
export function useLabelChoiceForWorkspace(
  workspaceId: string | undefined,
  filters: Filters,
  setFilters: (filters: Filters) => void,
): void {
  // Save the owner so switching still resets labels when a route remounts.
  useEffect(() => {
    if (!workspaceId || filters.labelsWorkspaceId === workspaceId) return
    setFilters({
      ...filters,
      labels: filters.labelsWorkspaceId ? [] : (filters.labels ?? []),
      labelsWorkspaceId: workspaceId,
    })
  }, [workspaceId, filters, setFilters])
}
