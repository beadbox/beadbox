// Per-workspace, in-memory, session-scoped view caches.
//
// Route components unmount when you navigate away and workspace surfaces
// remount when StartupGate re-checks, so every one of them would refetch
// from bd and repaint a placeholder for data it had seconds earlier. These
// caches hold the last rendered payload per workspace so a return trip
// paints immediately and refreshes in the background.
//
// Keyed by workspace id, NOT databasePath: the sidecar hands the client two
// spellings of the same path — runStartupHealth resolves
// `<project>/.beads/beads.db` (lib/workspace-registry.ts:resolveBdDbPath)
// while getWorkspaces resolves `<project>/.beads`
// (handlers/workspaces.ts:resolveLocalEntry). Keying on the path split each
// cache in two, so a payload stored on one code path was invisible to the
// other.
//
// Correctness stays with the sidecar's own fingerprint cache: these are
// stale-while-revalidate paints, never a substitute for a load.

import type { ActivityEvent, Epic, PipelineStage } from "./types"

const MAX_CACHED_WORKSPACES = 6

export interface WorkspaceSessionCache<T> {
  get(workspaceId: string | undefined): T | null
  set(workspaceId: string | undefined, value: T): void
  clear(workspaceId: string | undefined): void
  /** @internal Test-only reset. */
  reset(): void
}

/**
 * Bounded LRU keyed by workspace id. Re-inserting on read is what makes it
 * least-recently-used rather than insertion-ordered, so a long session across
 * many projects cannot pin arbitrarily many payloads.
 */
export function createWorkspaceSessionCache<T>(
  maxEntries: number = MAX_CACHED_WORKSPACES,
): WorkspaceSessionCache<T> {
  const entries = new Map<string, T>()

  return {
    get(workspaceId) {
      if (!workspaceId) return null
      const hit = entries.get(workspaceId)
      if (hit === undefined) return null
      entries.delete(workspaceId)
      entries.set(workspaceId, hit)
      return hit
    },
    set(workspaceId, value) {
      if (!workspaceId) return
      entries.delete(workspaceId)
      entries.set(workspaceId, value)
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
    },
    clear(workspaceId) {
      if (workspaceId) entries.delete(workspaceId)
    },
    reset() {
      entries.clear()
    },
  }
}

/** Epic tree behind the Beads view. */
export const sessionEpics = createWorkspaceSessionCache<Epic[]>()

/** Activity feed events. */
export const sessionActivityEvents = createWorkspaceSessionCache<ActivityEvent[]>()

export interface PipelineSnapshot {
  stages: PipelineStage[]
  beadStatuses: Map<string, string>
  fetchedAt: number
}

/** Activity pipeline card (bd list --json), with its own freshness stamp. */
export const sessionPipeline = createWorkspaceSessionCache<PipelineSnapshot>()

/** Drop every cached view for a workspace (e.g. after it is unregistered). */
export function clearWorkspaceSession(workspaceId: string | undefined): void {
  sessionEpics.clear(workspaceId ? `${workspaceId}:normal` : undefined)
  sessionEpics.clear(workspaceId ? `${workspaceId}:all` : undefined)
  sessionActivityEvents.clear(workspaceId)
  sessionPipeline.clear(workspaceId)
}

/** @internal Test-only reset of every cache. */
export function _resetWorkspaceSessions(): void {
  sessionEpics.reset()
  sessionActivityEvents.reset()
  sessionPipeline.reset()
}
