// Last-known epic tree per workspace, for the session.
//
// Switching projects used to repaint the skeleton every time, even when
// returning to a workspace whose beads were already on screen a second
// earlier: the switch resets hasExistingDataRef and the fresh getEpics()
// round trip (bd + Dolt) takes hundreds of ms to seconds.
//
// This keeps the last successful Epic[] per databasePath so a switch can
// paint immediately and refresh in the background (stale-while-revalidate).
// Session-scoped and in-memory on purpose: the sidecar's own fingerprint
// cache (packages/server/src/lib/epic-cache.ts) owns correctness, this only
// owns "what to show for the next few hundred milliseconds".
//
// Bounded so long sessions across many projects can't pin arbitrarily many
// trees: least-recently-used entry is dropped past the cap (re-inserting on
// read is what makes it LRU rather than insertion-ordered).

import type { Epic } from "./types"

const MAX_CACHED_WORKSPACES = 6

const cache = new Map<string, Epic[]>()

export function getSessionEpics(databasePath: string | undefined): Epic[] | null {
  if (!databasePath) return null
  const hit = cache.get(databasePath)
  if (!hit) return null
  cache.delete(databasePath)
  cache.set(databasePath, hit)
  return hit
}

export function setSessionEpics(databasePath: string | undefined, epics: Epic[]): void {
  if (!databasePath) return
  cache.delete(databasePath)
  cache.set(databasePath, epics)
  while (cache.size > MAX_CACHED_WORKSPACES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** Drop one workspace's entry (e.g. after it is removed from the registry). */
export function clearSessionEpics(databasePath: string | undefined): void {
  if (databasePath) cache.delete(databasePath)
}

/** @internal Test-only reset. */
export function _resetSessionEpics(): void {
  cache.clear()
}
