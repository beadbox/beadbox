// Workspace activate / unregister, shared by every surface that offers them.
//
// Three surfaces do the same two things: the /workspaces dashboard cards
// (components/workspaces-page.tsx), the workspace rail
// (hooks/use-workspace-rail.ts) and the beads view's lifecycle hook
// (hooks/use-workspace-lifecycle.ts). Each one used to carry its own copy
// of the sequence, and the copies had already drifted (missing success
// toast, missing trackedAction telemetry, different analytics `source`).
// The sequences live here; callers keep only their own UI state
// (spinners, navigation, dialogs).

import { trackedAction } from "./capture-action-failed"
import { getAnalyticsEnabled } from "./local-storage"
import { safeCapture } from "./posthog-safe"
import { rpc } from "./rpc"
import { deleteCredential } from "./tauri-credentials"
import type { DoltMode } from "./types"
import { setWorkspaceCookie } from "./workspace-cookie"
import { publishWorkspaceRegistryChange } from "./workspace-registry-events"
import { clearWorkspaceSession } from "./workspace-session-cache"

/** The fields every activate/unregister caller can supply. */
export interface WorkspaceRef {
  id: string
  name: string
  databasePath?: string
  mode?: DoltMode
}

/**
 * Make `workspace` the active one.
 *
 * Writing the cookie IS the switch: it is the single source of truth for
 * "active workspace" and it publishes, so StartupGate and every mounted
 * workspace surface re-resolve from it (see lib/workspace-cookie.ts). The
 * registry write is the durable half — it survives cookie loss across
 * restarts — and takes the databasePath, not the UUID (bb-qn71).
 */
export async function activateWorkspace(workspace: WorkspaceRef): Promise<void> {
  setWorkspaceCookie(workspace.id)
  if (workspace.databasePath) {
    try {
      await rpc.workspaces.setActiveWorkspaceAction(workspace.databasePath)
    } catch {
      // Cookie is set, so the switch happens for this session regardless.
    }
  }
  if (getAnalyticsEnabled()) {
    safeCapture("app_workspace_switch", { workspace_mode: workspace.mode ?? "embedded" })
  }
}

export type UnregisterResult = { ok: true } | { ok: false; error: string }

/**
 * Unregister `workspace` from ~/.beadbox/registry.json. Project files and
 * .beads data are left alone — this only forgets the entry.
 *
 * `source` distinguishes the surface in analytics ("ui" for the dashboard,
 * "rail" for the workspace rail).
 */
export async function unregisterWorkspace(
  workspace: WorkspaceRef,
  source: string,
): Promise<UnregisterResult> {
  const { databasePath } = workspace
  if (!databasePath) return { ok: false, error: "Workspace has no database path." }

  let result: Awaited<ReturnType<typeof rpc.workspaces.removeWorkspace>>
  try {
    result = await trackedAction("removeWorkspace", () =>
      rpc.workspaces.removeWorkspace(databasePath),
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!result.success) return { ok: false, error: result.error }

  if (result.credentialKey) {
    await deleteCredential(result.credentialKey)
  }
  clearWorkspaceSession(workspace.id)
  // The entry is gone from the registry, and a registry write raises no bd
  // change signal — tell the other surfaces (notably the rail, which is
  // mounted outside this one) to re-read.
  publishWorkspaceRegistryChange()
  if (getAnalyticsEnabled()) {
    safeCapture("app_workspace_removed", { source })
  }
  return { ok: true }
}
