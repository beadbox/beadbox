// Keep locally-held workspace objects in step with registry label writes.
//
// A rename or icon change is a registry write (rpc.workspaces.setWorkspaceLabel),
// and a registry write produces no bd change signal, so every surface holding
// its own resolved Workspace objects would keep showing the old label until it
// remounted. lib/workspace-labels.ts publishes the accepted label; this hook
// patches the copies a component holds.

import { type Dispatch, type SetStateAction, useEffect } from "react"
import { subscribeWorkspaceLabels } from "@/lib/workspace-labels"

interface LabelledWorkspace {
  id: string
  name: string
  icon?: string
}

interface WorkspaceLabelSyncOptions<T extends LabelledWorkspace> {
  /** The single active workspace, if the caller tracks one. */
  setActive?: Dispatch<SetStateAction<T | null>>
  /** The caller's workspace list, if it holds one. */
  setList?: Dispatch<SetStateAction<T[]>>
}

export function useWorkspaceLabelSync<T extends LabelledWorkspace>({
  setActive,
  setList,
}: WorkspaceLabelSyncOptions<T>): void {
  useEffect(
    () =>
      subscribeWorkspaceLabels(({ workspaceId, name, icon }) => {
        setActive?.((prev) => (prev && prev.id === workspaceId ? { ...prev, name, icon } : prev))
        setList?.((prev) =>
          prev.map((workspace) =>
            workspace.id === workspaceId ? { ...workspace, name, icon } : workspace,
          ),
        )
      }),
    [setActive, setList],
  )
}
