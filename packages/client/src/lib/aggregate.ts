import { collectAllBeadsFromEpics } from "./epic-tree-utils"
import type { Bead, Epic, WorkspaceCard } from "./types"

export interface ProjectSnapshot {
  workspace: WorkspaceCard
  epics: Epic[]
  error?: string
  /** The registry's databasePath when the sidecar last resolved this source. */
  registryPath?: string
}

/**
 * Apply a registry refresh to the loaded snapshots. The registry card spells a
 * local database as `<project>/.beads`; the sidecar's read resolves the same
 * database as `<project>/.beads/beads.db`, the spelling every workspace view
 * uses. Writes and detail reads must use one spelling: the sidecar keys its
 * per-database lock and caches on the string. So a resolved path is kept while
 * the registry still names the same database, and dropped if it moved.
 */
export function mergeRegistry(
  old: readonly ProjectSnapshot[],
  cards: readonly WorkspaceCard[],
): ProjectSnapshot[] {
  return cards.map((card) => {
    const prev = old.find((s) => s.workspace.id === card.id)
    if (!prev) return { workspace: card, epics: [] }
    if (prev.registryPath !== undefined && prev.registryPath === card.databasePath)
      return { ...prev, workspace: { ...card, databasePath: prev.workspace.databasePath } }
    return { ...prev, workspace: card, registryPath: undefined }
  })
}

export interface Backoff {
  failures: number
  retryAt: number
}

export const BACKOFF_BASE_MS = 5_000
export const BACKOFF_MAX_MS = 5 * 60_000

/** After each consecutive failure, wait twice as long (5 s, 10 s, ... 5 min). */
export function nextBackoff(prev: Backoff | undefined, now: number): Backoff {
  const failures = (prev?.failures ?? 0) + 1
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
  return { failures, retryAt: now + wait }
}

/**
 * The sources to read this cycle: healthy ones first, then failed ones whose
 * backoff has expired. An unreachable source can wait out a long timeout, so it
 * must not take a read slot every cycle ahead of the projects that answer.
 * A forced refresh (the Refresh button, a registry change) retries every source.
 */
export function dueSources<T extends { id: string }>(
  items: readonly T[],
  backoff: ReadonlyMap<string, Backoff>,
  now: number,
  force: boolean,
): T[] {
  const healthy = items.filter((item) => !backoff.has(item.id))
  const failed = items.filter((item) => {
    const state = backoff.get(item.id)
    return state !== undefined && (force || state.retryAt <= now)
  })
  return [...healthy, ...failed]
}

export interface ProjectBead {
  key: string
  workspace: WorkspaceCard
  bead: Bead
}

export function projectBeadKey(workspaceId: string, beadId: string): string {
  return JSON.stringify([workspaceId, beadId])
}

export function projectBeads(snapshot: ProjectSnapshot): ProjectBead[] {
  const seen = new Set<string>()
  return collectAllBeadsFromEpics(snapshot.epics)
    .filter((bead) => {
      if (bead.id === "_standalone" || seen.has(bead.id)) return false
      seen.add(bead.id)
      return true
    })
    .map((bead) => ({
      key: projectBeadKey(snapshot.workspace.id, bead.id),
      workspace: snapshot.workspace,
      bead,
    }))
}

/** At most two sources in flight; no next cycle until this one has settled. */
export async function readProjects<T>(
  items: readonly T[],
  read: (item: T) => Promise<void>,
  cancelled: () => boolean,
) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(2, items.length) }, async () => {
      while (!cancelled() && next < items.length) {
        const item = items[next++]
        await read(item)
      }
    }),
  )
}
