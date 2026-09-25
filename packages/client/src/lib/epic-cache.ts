import type { Bead, Epic } from "./types"

export interface FingerprintParts {
  headHash: string
  maxUpdatedAt: string
  commentFp: string
}

let cachedFingerprint: string | null = null
let cachedDbPath: string | null = null
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

export function getCachedEpics(fingerprint: string, dbPath: string): Epic[] | null {
  if (fingerprint === cachedFingerprint && dbPath === cachedDbPath && cachedResult) {
    return cachedResult
  }
  return null
}

export function setCachedEpics(fingerprint: string, dbPath: string, epics: Epic[]): void {
  cachedFingerprint = fingerprint
  cachedDbPath = dbPath
  cachedResult = epics
  cachedParts = parseFingerprint(fingerprint)
}

export function getCachedFingerprintParts(): FingerprintParts | null {
  return cachedParts
}

export function getCachedDbPath(): string | null {
  return cachedDbPath
}

export function hasCachedResult(): boolean {
  return cachedResult !== null
}

// Patch specific beads into the cached Epic[] tree by ID.
// Walks the tree recursively, replacing any bead whose ID matches a patch.
// Updates the stored fingerprint after patching.
export function patchCachedBeads(
  patches: Map<string, Bead>,
  newFingerprint: string,
  dbPath: string,
): Epic[] | null {
  if (!cachedResult || dbPath !== cachedDbPath) return null

  function patchBead(bead: Bead): Bead {
    const patch = patches.get(bead.id)
    const base = patch
      ? {
          ...bead,
          ...patch,
          children: bead.children,
          blockedBy: bead.blockedBy,
          blocks: bead.blocks,
          orphanedFromEpic: bead.orphanedFromEpic,
        }
      : bead
    if (base.children && base.children.length > 0) {
      base.children = base.children.map(patchBead)
    }
    return base
  }

  function patchEpic(epic: Epic): Epic {
    const patch = patches.get(epic.id)
    const base = patch
      ? ({
          ...epic,
          ...patch,
          type: epic.type,
          children: epic.children,
          childEpics: epic.childEpics,
        } as Epic)
      : { ...epic }
    base.children = base.children.map(patchBead)
    if (base.childEpics && base.childEpics.length > 0) {
      base.childEpics = base.childEpics.map(patchEpic)
    }
    return base
  }

  cachedResult = cachedResult.map(patchEpic)
  cachedFingerprint = newFingerprint
  cachedParts = parseFingerprint(newFingerprint)
  return cachedResult
}

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
  if (!treeBead?.updatedAt) return null
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
  cachedResult = null
  cachedParts = null
  beadDetailCache.clear()
}
