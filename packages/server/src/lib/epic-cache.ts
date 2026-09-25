import type { Bead, Epic } from "./types"

export interface FingerprintParts {
  headHash: string
  maxUpdatedAt: string
  commentFp: string
}

let cachedFingerprint: string | null = null
let cachedDbPath: string | null = null
let cachedIncludeSystem = false
let cachedResult: Epic[] | null = null
let cachedParts: FingerprintParts | null = null

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

export function getCachedEpics(fingerprint: string, dbPath: string, includeSystem = false): Epic[] | null {
  if (fingerprint === cachedFingerprint && dbPath === cachedDbPath && includeSystem === cachedIncludeSystem && cachedResult) {
    return cachedResult
  }
  return null
}

export function setCachedEpics(fingerprint: string, dbPath: string, epics: Epic[], includeSystem = false): void {
  cachedFingerprint = fingerprint
  cachedDbPath = dbPath
  cachedIncludeSystem = includeSystem
  cachedResult = epics
  cachedParts = parseFingerprint(fingerprint)
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
// keyed by bead ID. Each entry tracks updated_at + commentCount for staleness checks.
interface BeadDetailEntry {
  bead: Bead
  updatedAt: string // ISO string from bead.updatedAt
  commentCount: number
}
const beadDetailCache = new Map<string, BeadDetailEntry>()

// Find a bead in the cached epic tree by ID. Walks all epics and their children.
export function findBeadInCachedTree(id: string): Bead | null {
  if (!cachedResult) return null
  for (const epic of cachedResult) {
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
export function getCachedBeadDetail(id: string): Bead | null {
  const entry = beadDetailCache.get(id)
  if (!entry) return null
  // Validate against current epic tree state
  const treeBead = findBeadInCachedTree(id)
  if (!treeBead || !treeBead.updatedAt) return null
  const treeUpdatedAt = treeBead.updatedAt.toISOString()
  const treeCommentCount = treeBead.commentCount ?? 0
  if (entry.updatedAt === treeUpdatedAt && entry.commentCount === treeCommentCount) {
    return entry.bead
  }
  // Stale - remove entry
  beadDetailCache.delete(id)
  return null
}

export function setCachedBeadDetail(bead: Bead): void {
  if (!bead.updatedAt) return
  beadDetailCache.set(bead.id, {
    bead,
    updatedAt: bead.updatedAt.toISOString(),
    commentCount: bead.commentCount ?? bead.comments.length,
  })
}

// Cache stats for developer mode diagnostics
export function getBeadDetailCacheStats(): {
  size: number
  entries: Array<{ id: string; commentCount: number }>
} {
  return {
    size: beadDetailCache.size,
    entries: Array.from(beadDetailCache.entries()).map(([id, e]) => ({
      id,
      commentCount: e.commentCount,
    })),
  }
}

export function clearBeadDetailCache(): void {
  beadDetailCache.clear()
}

export function invalidateEpicCache(): void {
  cachedFingerprint = null
  cachedDbPath = null
  cachedIncludeSystem = false
  cachedResult = null
  cachedParts = null
  beadDetailCache.clear()
}
