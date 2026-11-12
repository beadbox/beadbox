// Per-user executable selection shared by Settings and startup recovery.
import { homedir } from "os"
import { join } from "path"
import { getBdPathSelection, resetPathCaches, validateBdPath } from "../lib/bd-paths"
import { writeSavedBdPath } from "../lib/bd-preferences"
import { beadsDirFromDatabasePath } from "../lib/beadtrain-fs"
import { invalidateEpicCache } from "../lib/epic-cache"
import { resetServeReads } from "../lib/serve-reads"
import { restartWorkspaceSubscriptions, state } from "./subscribe-internals"

let pending: Promise<unknown> = Promise.resolve()

/** Read the active path, source and saved preference. */
export async function getBdPath() {
  return getBdPathSelection()
}

/** Validate and save the global choice, then replace long-lived bd consumers. */
export function setBdPath(path: string | null): Promise<ReturnType<typeof getBdPathSelection>> {
  const operation = pending.then(async () => {
    let normalized = path === null ? null : path.trim()
    if (normalized === "~") normalized = homedir()
    else if (normalized?.startsWith("~/")) normalized = join(homedir(), normalized.slice(2))
    if (normalized !== null) await validateBdPath(normalized)
    writeSavedBdPath(normalized)
    resetPathCaches()
    invalidateEpicCache()
    await resetServeReads()
    // The restart helper preserves subscription IDs and reports failures to clients.
    const restarts = await Promise.allSettled(
      [...new Set([...state.paths.values()].map((p) => beadsDirFromDatabasePath(p) ?? p))].map(
        (workspace) => restartWorkspaceSubscriptions(workspace),
      ),
    )
    if (restarts.some((result) => result.status === "rejected")) {
      throw new Error("bd path saved; a subscription could not restart. Retry the workspace.")
    }
    return getBdPathSelection()
  })
  pending = operation.catch(() => {})
  return operation
}
