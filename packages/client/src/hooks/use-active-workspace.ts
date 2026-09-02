// Resolve the active workspace from the workspace cookie, and keep it
// resolved.
//
// The cookie is the source of truth for "which workspace is active"
// (lib/workspace-cookie.ts). Two things make a subscription necessary rather
// than a one-shot read: the workspace rail switches projects by writing the
// cookie, and StartupGate no longer remounts route components for a
// workspace it already health-checked this session — so nothing else would
// tell a mounted page that the project changed.
//
// Used by the routes that hold a workspace list but not the full beads
// lifecycle (activity-page, formulas-view). home-page's useWorkspaceLifecycle
// owns its own resolution because it also drives epic loading.

import { type Dispatch, type SetStateAction, useEffect, useState } from "react"
import type { Workspace } from "@/lib/types"
import { getWorkspaceCookie, subscribeWorkspaceCookie } from "@/lib/workspace-cookie"

export function useActiveWorkspace(
  workspaces: Workspace[],
): [Workspace | null, Dispatch<SetStateAction<Workspace | null>>] {
  const [active, setActive] = useState<Workspace | null>(null)

  useEffect(() => {
    const resolve = () => {
      const savedId = getWorkspaceCookie()
      setActive((prev) => {
        const found = savedId ? workspaces.find((w) => w.id === savedId) : undefined
        // Unknown id (e.g. the cookie was cleared, or the list is stale):
        // keep the workspace we are on rather than silently jumping to a
        // different project. Falling back to workspaces[0] only applies
        // before anything is resolved.
        return found ?? prev ?? workspaces[0] ?? null
      })
    }
    resolve()
    return subscribeWorkspaceCookie(resolve)
  }, [workspaces])

  return [active, setActive]
}
