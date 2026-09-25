import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute } from "node:path"
import type { BdOptions } from "../lib/bd"
import { resolveWorkspaceTarget, type WorkspaceTarget } from "../lib/workspace-resolver"

/** Resolve one RPC workspace once, before any read or write begins. */
export async function workspaceTargetOptions(idOrPath?: string): Promise<{
  target: WorkspaceTarget | null
  dbPath: string | undefined
  options: BdOptions
}> {
  if (!idOrPath) return { target: null, dbPath: undefined, options: {} }
  let target: WorkspaceTarget
  try {
    target = await resolveWorkspaceTarget(idOrPath)
  } catch (error) {
    // Existing ad hoc local workspaces (including test fixtures) have no
    // registry UUID. Keep their CLI route, but never make them HTTP targets.
    // Ambiguous registered paths and unregistered server:// URIs still fail.
    const beadsDir = basename(idOrPath) === ".beads" ? idOrPath : dirname(idOrPath)
    if (
      isAbsolute(idOrPath) &&
      basename(beadsDir) === ".beads" &&
      existsSync(beadsDir) &&
      error instanceof Error &&
      error.message.startsWith("Workspace not found:")
    ) {
      return { target: null, dbPath: idOrPath, options: { db: idOrPath } }
    }
    throw error
  }
  const options: BdOptions = { db: target.cliDbPath, workspaceId: target.id }
  if (target.mode === "server" && !target.localBeadsDir && target.serverConnection) {
    options.server = { ...target.serverConnection }
  }
  return { target, dbPath: target.cliDbPath, options }
}
