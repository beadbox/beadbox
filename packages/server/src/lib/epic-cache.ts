import type { Bead, Epic } from "./types"

export interface FingerprintParts {
  headHash: string
  maxUpdatedAt: string
  commentFp: string
}

let cachedDbPath: string | null = null
let cachedIncludeSystem = false
let cachedResult: Epic[] | null = null
let cachedParts: FingerprintParts | null = null
// Bounded source cache: keys include the database and system-bead view.
// Legacy diagnostics/incrementalRefresh keep the last-used slot above.
const trees = new Map<
  string,
  { fingerprint: string; epics: Epic[]; blockedBy: Map<string, string[]> | null }
>()
const treeKey = (dbPath: string, includeSystem = false) => JSON.stringify([dbPath, includeSystem])

// Parse a fingerprint JSON string into its component parts.
// Fingerprint format: [{"h":"<HEAD hash>","i":"<max updated_at>","c":"<count:maxId>"}]
export function parseFingerprint(fingerprint: string): FingerprintParts | null {
  try {
    const rows = JSON.parse(fingerprint) as Array<Record<string, string>>
    if (!rows || rows.length === 0) return null
    const row = rows[0]
    return {
      headHash: row.h || "",
      maxUpdatedAt: row.i || "",
      commentFp: row.c || "",
    }
  } catch {
    return null
  }
}

export function getCachedEpics(
  fingerprint: string,
  dbPath: string,
  includeSystem = false,
): Epic[] | null {
  const entry = trees.get(treeKey(dbPath, includeSystem))
  if (entry?.fingerprint !== fingerprint) return null
  cachedDbPath = dbPath
  cachedIncludeSystem = includeSystem
  cachedResult = entry.epics
  cachedParts = parseFingerprint(fingerprint)
  return entry.epics
}

export function setCachedEpics(
  fingerprint: string,
  dbPath: string,
  epics: Epic[],
  includeSystem = false,
  blockedBy: Map<string, string[]> | null = null,
): void {
  // A tree built from different data makes every cached detail suspect, even
  // when the bead's updated_at and comment count did not move: bd's label
  // writes bump neither (beadbox-o9a). Unchanged data never reaches here (the
  // fingerprint cache hit returns first), so idle detail reads still hit.
  const key = treeKey(dbPath, includeSystem)
  const otherKey = treeKey(dbPath, !includeSystem)
  const other = trees.get(otherKey)
  if (other && other.fingerprint !== fingerprint) trees.delete(otherKey)
  if (trees.get(key)?.fingerprint !== fingerprint) {
    for (const [detailKey, detail] of beadDetailCache) {
      if (detail.dbPath === dbPath) beadDetailCache.delete(detailKey)
    }
  }
  trees.delete(key)
  trees.set(key, { fingerprint, epics, blockedBy })
  if (trees.size > 32) trees.delete(trees.keys().next().value!)
  cachedDbPath = dbPath
  cachedIncludeSystem = includeSystem
  cachedResult = epics
  cachedParts = parseFingerprint(fingerprint)
}

/**
 * Blocked-by computed with the cached tree, if that tree is for `dbPath` and
 * was built from data with this fingerprint. Either list (with or without
 * system beads) carries every dependency edge of the issues it lists.
 */
export function getCachedBlockedBy(
  fingerprint: string,
  dbPath: string,
): Map<string, string[]> | null {
  const entry = trees.get(treeKey(dbPath)) ?? trees.get(treeKey(dbPath, true))
  return entry?.fingerprint === fingerprint ? entry.blockedBy : null
}

export function getCachedFingerprintParts(): FingerprintParts | null {
  return cachedParts
}

export function getCachedDbPath(): string | null {
  return cachedDbPath
}

export function getCachedIncludeSystem(): boolean {
  return cachedIncludeSystem
}

export function hasCachedResult(): boolean {
  return cachedResult !== null
}

// bb-3gnz.5: removed `patchCachedBeads` (was the worker for the dead
// patch paths in epics.ts incrementalRefresh). Per Shape D verdict
// (2026-05-07): HASHOF('HEAD') flips on every Dolt commit so the
// headHash check in incrementalRefresh always falls into fullRebuild
// before reaching anything that would have called patchCachedBeads.
// The only call sites were the dropped maybePatchByMaxUpdatedAt and
// maybePatchByCommentFp helpers in epics.ts.

// Per-bead detail cache: stores full Bead objects (with comments, blockedBy, etc.)
// keyed by source database + bead ID. Each entry tracks updated_at + commentCount for staleness checks.
interface BeadDetailEntry {
  dbPath: string
  bead: Bead
  updatedAt: string // ISO string from bead.updatedAt
  commentCount: number
}
const beadDetailCache = new Map<string, BeadDetailEntry>()

// Find a bead in the cached epic tree by ID. Walks all epics and their children.
export function findBeadInCachedTree(id: string, dbPath = cachedDbPath ?? ""): Bead | null {
  const tree = trees.get(treeKey(dbPath)) ?? trees.get(treeKey(dbPath, true))
  if (!tree) return null
  for (const epic of tree.epics) {
    if (epic.id === id) return epic
    const found = searchChildren(epic, id)
    if (found) return found
  }
  return null
}

function searchChildren(parent: Bead | Epic, id: string): Bead | null {
  if (parent.children) {
    for (const child of parent.children) {
      if (child.id === id) return child
      const found = searchChildren(child, id)
      if (found) return found
    }
  }
  if ("childEpics" in parent && parent.childEpics) {
    for (const childEpic of parent.childEpics) {
      if (childEpic.id === id) return childEpic
      const found = searchChildren(childEpic, id)
      if (found) return found
    }
  }
  return null
}

// Look up a cached bead detail. Validates against the epic tree's
// updated_at + commentCount to detect staleness from WS-triggered refreshes.
export function getCachedBeadDetail(id: string, dbPath = cachedDbPath ?? ""): Bead | null {
  const key = JSON.stringify([dbPath, id])
  const entry = beadDetailCache.get(key)
  if (!entry) return null
  // Validate against current epic tree state
  const treeBead = findBeadInCachedTree(id, dbPath)
  if (!treeBead || !treeBead.updatedAt) return null
  const treeUpdatedAt = treeBead.updatedAt.toISOString()
  const treeCommentCount = treeBead.commentCount ?? 0
  if (entry.updatedAt === treeUpdatedAt && entry.commentCount === treeCommentCount) {
    return entry.bead
  }
  // Stale - remove entry
  beadDetailCache.delete(key)
  return null
}

export function setCachedBeadDetail(bead: Bead, dbPath = cachedDbPath ?? ""): void {
  if (!bead.updatedAt) return
  beadDetailCache.set(JSON.stringify([dbPath, bead.id]), {
    dbPath,
    bead,
    updatedAt: bead.updatedAt.toISOString(),
    commentCount: bead.commentCount ?? bead.comments.length,
  })
  if (beadDetailCache.size > 512) beadDetailCache.delete(beadDetailCache.keys().next().value!)
}

// Cache stats for developer mode diagnostics
export function getBeadDetailCacheStats(): {
  size: number
  entries: Array<{ id: string; commentCount: number }>
} {
  return {
    size: beadDetailCache.size,
    entries: Array.from(beadDetailCache.values()).map((e) => ({
      id: e.bead.id,
      commentCount: e.commentCount,
    })),
  }
}

export function clearBeadDetailCache(): void {
  beadDetailCache.clear()
}

export function invalidateEpicCache(): void {
  trees.clear()
  cachedDbPath = null
  cachedIncludeSystem = false
  cachedResult = null
  cachedParts = null
  beadDetailCache.clear()
}
