// Epics handler namespace. Mirrors every export of actions/epics.ts.
//
// Same name + signature + return shape parity as the actions. Internals call
// into ../lib/bd (the source-local copy). No "use server" annotation.
//
// Channel discipline: console.log calls in the original are replaced with
// console.error so they route to stderr in the sidecar (stdout is reserved
// for kkrpc frames). index.ts also redirects console.log globally as a
// belt-and-suspenders, but the explicit rewrite here documents the intent.

import { basename, dirname, resolve } from "node:path"
import {
  type BdBead,
  type BdComment,
  type BdOptions,
  getAllBlocksDependencies,
  getComments,
  getDataFingerprint,
  listBeads,
  mapPriority,
  mapType,
  readBeadDetail,
} from "../lib/bd"
import type { BdLoadError } from "../lib/bd-error"
import { toBdLoadError } from "../lib/bd-error"
import { readMetadataMode } from "../lib/dolt-metadata"
import {
  getBeadDetailCacheStats,
  getCachedBeadDetail,
  getCachedDbPath,
  getCachedEpics,
  getCachedFingerprintParts,
  getCachedIncludeSystem,
  hasCachedResult,
  parseFingerprint,
  setCachedBeadDetail,
  setCachedEpics,
} from "../lib/epic-cache"
import { consumeEpicPrefetch, startEpicPrefetch } from "../lib/epic-prefetch"
import { matchRig, parseRoutes } from "../lib/routes"
import { ServeHttpError } from "../lib/serve-http"
import type { Bead, BeadPriority, BeadStatus, Comment, Epic } from "../lib/types"
import { workspaceTransition } from "../lib/workspace-transition"
import { workspaceTargetOptions } from "./workspace-target-options"

// Convert bd ISO date string to Date
function toDate(isoString?: string): Date | undefined {
  if (!isoString) return undefined
  return new Date(isoString)
}

// Convert BdComment to Comment
function convertComment(bdComment: BdComment): Comment {
  return {
    id: bdComment.id,
    author: bdComment.author,
    content: bdComment.text,
    timestamp: new Date(bdComment.created_at),
  }
}

// Convert BdBead to Bead (without children/childEpics)
function convertBead(bdBead: BdBead, comments: Comment[] = []): Bead {
  return {
    id: bdBead.id,
    type: mapType(bdBead.issue_type),
    title: bdBead.title,
    description: bdBead.description || "",
    design: bdBead.design,
    acceptanceCriteria: bdBead.acceptance_criteria,
    notes: bdBead.notes,
    externalRef: bdBead.external_ref,
    specId: bdBead.spec_id,
    dueAt: toDate(bdBead.due_at),
    deferUntil: toDate(bdBead.defer_until),
    estimatedMinutes: bdBead.estimated_minutes,
    status: bdBead.status as BeadStatus,
    priority: mapPriority(bdBead.priority) as BeadPriority,
    assignee: bdBead.assignee || "",
    labels: bdBead.labels || [],
    metadata: bdBead.metadata,
    comments,
    commentCount: bdBead.comment_count ?? comments.length,
    parentId: bdBead.parent,
    createdAt: toDate(bdBead.created_at),
    updatedAt: toDate(bdBead.updated_at),
  }
}

// Build epic hierarchy from flat list of beads
// Optimized: uses only 2 bd CLI calls instead of N+1
async function buildEpicHierarchy(options: BdOptions = {}): Promise<Epic[]> {
  const dbKey = options.db ?? ""
  const currentFingerprint = await getDataFingerprint({ ...options, parallel: true })
  const cached = getCachedEpics(currentFingerprint, dbKey, options.includeSystem)
  if (cached) return cached

  // Detect server mode for parallel read optimization
  let readOptions = options
  if (options.db) {
    const mode = await readMetadataMode(options.db)
    if (mode === "server") {
      readOptions = { ...options, parallel: true }
    }
  }

  // Step 1: Get ALL beads in one call (includes parent field)
  const allBeads = await listBeads(readOptions)

  const hierarchicalTypes = new Set(["epic", "milestone", "convoy", "molecule"])
  const epicBeads = allBeads.filter((b) => hierarchicalTypes.has(b.issue_type))
  const nonEpicBeads = allBeads.filter((b) => !hierarchicalTypes.has(b.issue_type))

  const childrenFromParentField = new Map<string, BdBead[]>()
  for (const bead of allBeads) {
    if (bead.parent) {
      const siblings = childrenFromParentField.get(bead.parent)
      if (siblings) siblings.push(bead)
      else childrenFromParentField.set(bead.parent, [bead])
    }
  }

  const epicsWithDependents: BdBead[] = epicBeads.map((epic) => ({
    ...epic,
    dependents: (childrenFromParentField.get(epic.id) || [])
      .filter((c) => c.status !== "tombstone" && !c.deleted_at)
      .map((c) => ({ ...c, dependency_type: "parent-child" as const })),
  }))

  // beadbox-fti: derive non-epic-parent children from childrenFromParentField
  // (the bead.parent index built above at line 115) rather than fetching each
  // parent's full shape via showBeads. Empirically verified consistent on
  // beadbox + hover workspaces: both representations agree on every parent's
  // child list, so the showBeads round-trip was pure redundancy — and it was
  // 84% of incrementalRefresh's budget on hover (3.7s / 4.4s total).
  //
  // The earlier `dependent_count > 0` pre-filter is dropped intentionally:
  // (a) it's no longer useful for perf (a Map.get returning undefined is
  // microseconds) and (b) in fresh embedded-mode workspaces bd's
  // `dependent_count` is sometimes stale/zero even after a real reparenting,
  // so trusting it as a "has children" gate skipped real children.
  const childrenByParent = new Map<string, BdBead[]>()
  for (const bead of nonEpicBeads) {
    const children = (childrenFromParentField.get(bead.id) || [])
      .filter((c) => c.status !== "tombstone" && !c.deleted_at)
      .map((c) => ({ ...c, dependency_type: "parent-child" as const }))
    if (children.length > 0) {
      childrenByParent.set(bead.id, children)
    }
  }

  const beadById = new Map<string, BdBead>(allBeads.map((b) => [b.id, b]))
  const epicDependentsById = new Map<string, BdBead[]>(
    epicsWithDependents.map((e) => [e.id, e.dependents || []]),
  )

  function buildBeadWithChildren(bdBead: BdBead, depth: number = 0): Bead {
    const baseBead = convertBead(bdBead)
    if (depth >= 5) return baseBead

    const children = childrenByParent.get(bdBead.id) || []
    if (children.length === 0) return baseBead

    return {
      ...baseBead,
      children: children.map((child) =>
        hierarchicalTypes.has(child.issue_type)
          ? (epicMap.get(child.id) ?? convertBead(child))
          : buildBeadWithChildren(child, depth + 1),
      ),
    }
  }

  const epicMap = new Map<string, Epic>()
  const childEpicIds = new Set<string>()

  for (const bdEpic of epicsWithDependents) {
    const epic: Epic = {
      ...convertBead(bdEpic),
      children: [],
      childEpics: [],
    }
    epicMap.set(bdEpic.id, epic)
  }

  // A hierarchy root under a non-epic parent is rendered among that parent's
  // children. It must not also appear as an independent top-level epic.
  for (const bdEpic of epicBeads) {
    const parent = bdEpic.parent ? beadById.get(bdEpic.parent) : undefined
    if (parent && !hierarchicalTypes.has(parent.issue_type)) {
      childEpicIds.add(bdEpic.id)
    }
  }

  for (const bdEpic of epicsWithDependents) {
    const epic = epicMap.get(bdEpic.id)!
    const dependents = epicDependentsById.get(bdEpic.id) || []

    for (const dependent of dependents) {
      if (dependent.dependency_type !== "parent-child") continue
      if (dependent.status === "tombstone" || dependent.deleted_at) continue

      if (hierarchicalTypes.has(dependent.issue_type)) {
        const childEpic = epicMap.get(dependent.id)
        if (childEpic) {
          childEpic.parentId = epic.id
          epic.childEpics!.push(childEpic)
          childEpicIds.add(dependent.id)
        }
      } else {
        const fullBead = beadById.get(dependent.id) || dependent
        const childBead = buildBeadWithChildren(fullBead)
        childBead.parentId = epic.id
        epic.children.push(childBead)
      }
    }
  }

  const topLevelEpics = Array.from(epicMap.values()).filter((e) => !childEpicIds.has(e.id))

  const beadsUnderEpics = new Set<string>()
  for (const bdEpic of epicsWithDependents) {
    const dependents = epicDependentsById.get(bdEpic.id) || []
    for (const dep of dependents) {
      beadsUnderEpics.add(dep.id)
    }
  }

  const beadsUnderParents = new Set<string>()
  for (const children of childrenByParent.values()) {
    for (const child of children) {
      beadsUnderParents.add(child.id)
    }
  }

  const orphanBeads = nonEpicBeads.filter(
    (bead) => !beadsUnderEpics.has(bead.id) && !beadsUnderParents.has(bead.id),
  )

  if (orphanBeads.length > 0) {
    const orphanChildren = orphanBeads.map((b) => {
      const child = buildBeadWithChildren(b)
      if (b.parent) {
        const parentBead = beadById.get(b.parent)
        if (
          parentBead &&
          (parentBead.status === "closed" || parentBead.labels?.includes("archived"))
        ) {
          child.orphanedFromEpic = { id: parentBead.id, title: parentBead.title }
        }
      }
      return child
    })

    const orphanEpic: Epic = {
      id: "_standalone",
      type: "epic",
      title: "Beads (No Epic)",
      description: "Beads without a parent epic",
      status: "open",
      priority: "low",
      assignee: "",
      labels: [],
      comments: [],
      children: orphanChildren,
      childEpics: [],
    }
    topLevelEpics.push(orphanEpic)
  }

  // Generic Bead consumers traverse `children`, while top-level Epic consumers
  // traverse `childEpics`. Once an epic is nested below a non-epic issue, keep
  // the entire descendant branch on `children` so both tree views can reach it.
  function normalizeNestedEpics(bead: Bead, belowNonEpic = false): void {
    if (belowNonEpic && "childEpics" in bead) {
      const epic = bead as Epic
      epic.children.push(...(epic.childEpics ?? []))
      epic.childEpics = []
    }
    const childBelowNonEpic = belowNonEpic || !hierarchicalTypes.has(bead.type)
    bead.children?.forEach((child) => {
      normalizeNestedEpics(child, childBelowNonEpic)
    })
    if ("childEpics" in bead) {
      ;(bead as Epic).childEpics?.forEach((child) => {
        normalizeNestedEpics(child, childBelowNonEpic)
      })
    }
  }
  topLevelEpics.forEach((epic) => {
    normalizeNestedEpics(epic)
  })

  // Attach rigName from routes.jsonl (Gastown multi-rig workspaces)
  const dbPath = options.db || process.cwd()
  const beadsDir = basename(resolve(dbPath)) === ".beads" ? dbPath : dirname(dbPath)
  const routes = await parseRoutes(beadsDir)
  if (routes.size > 0) {
    function attachRigNames(bead: Bead) {
      bead.rigName = matchRig(bead.id, routes)
      bead.children?.forEach(attachRigNames)
      if ("childEpics" in bead) (bead as Epic).childEpics?.forEach(attachRigNames)
    }
    topLevelEpics.forEach(attachRigNames)
  }

  if (currentFingerprint) {
    setCachedEpics(currentFingerprint, dbKey, topLevelEpics, options.includeSystem)
  }

  return topLevelEpics
}

// Discriminated union: structured result that crosses the kkrpc boundary
// without losing error classification (no instanceof needed).
/** @internal Used by tests only; no production consumers. */
export type EpicResult =
  | { success: true; epics: Epic[] }
  | { success: false; bdLoadError: BdLoadError }

async function getEpicsCoreUnscoped(options: BdOptions): Promise<EpicResult> {
  const dbPath = options.db
  try {
    const epics = await buildEpicHierarchy(options)
    // beadbox-jk7 / cascade-9 diagnostic. Sidecar-side proof of what the
    // RPC layer is about to serialize back to the renderer. Pair with the
    // renderer-side window.__BEADBOX__.loadEpics stamp to discriminate
    // kkrpc serialization drop vs gen-guard race vs onStderr-Windows-broken.
    const firstId = epics[0]?.id ?? "-"
    const firstChildCount = epics[0]?.children?.length ?? 0
    console.error(
      `[debug:cascade9] getEpicsCore N=${epics.length} db=${dbPath ?? "<cwd>"} first=${firstId} childCount=${firstChildCount}`,
    )
    return { success: true, epics }
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[debug:cascade9] getEpicsCore THREW db=${dbPath ?? "<cwd>"} msg=${msg}`)
    if (code === "ENOENT" || msg.includes("ENOENT")) {
      return {
        success: false,
        bdLoadError: {
          category: "unknown",
          severity: "transient",
          message: "BD_NOT_FOUND: bd CLI binary is missing or not accessible",
          stderr: null,
          fixCommand: null,
          fixDescription: null,
        },
      }
    }
    return { success: false, bdLoadError: toBdLoadError(error) }
  }
}

function getEpicsCore(options: BdOptions): Promise<EpicResult> {
  const run = () => getEpicsCoreUnscoped(options)
  return options.workspaceId ? workspaceTransition.withOperation(options.workspaceId, run) : run()
}

// Get all epics with their hierarchy.
// Checks for a prefetched result first (started during health check).
export async function getEpics(dbPath?: string, includeSystem = false): Promise<EpicResult> {
  const resolved = await workspaceTargetOptions(dbPath)
  const options = { ...resolved.options, includeSystem }
  const prefetched = includeSystem ? null : consumeEpicPrefetch(resolved.dbPath)
  if (prefetched) {
    console.error("[epics] using prefetched epic data")
    return prefetched
  }
  return getEpicsCore(options)
}

// Start prefetching epic data.
export async function prefetchEpicData(dbPath?: string): Promise<void> {
  try {
    const resolved = await workspaceTargetOptions(dbPath)
    startEpicPrefetch(resolved.dbPath, async () => {
      try {
        return await getEpicsCore(resolved.options)
      } catch (error) {
        return { success: false, bdLoadError: toBdLoadError(error) }
      }
    })
  } catch (error) {
    console.warn(`[epics] prefetch skipped: ${error instanceof Error ? error.message : error}`)
  }
}

// bb-3gnz.5: dropped the maybePatchByMaxUpdatedAt + maybePatchByCommentFp
// helpers + the post-headHash-mismatch patch block they fed into. The
// patch paths were unreachable in production — Shape D investigation
// (2026-05-07) confirmed that HASHOF('HEAD') flips on every Dolt commit
// in BOTH server and embedded mode, so the headHash inequality below
// always falls into the fullRebuild branch first. The patch helpers
// also depended on getChangedBeadIds returning a non-empty list, which
// is hard-coded to [] on embedded mode (bd.ts:isEmbeddedMode early
// return), making the bb-onv3.6-tracked stale-cache-as-success bug
// latent on that path. Removing the dead branches kills both surfaces
// at once. Per pm/systemdesign.md §3.1 (Real-Time Pipeline) the
// post-event refresh contract is unchanged: cache-hit on no-change,
// fullRebuild on any change.

async function fullRebuild(options: BdOptions): Promise<EpicResult> {
  const epics = await buildEpicHierarchy(options)
  return { success: true, epics }
}

// Incremental refresh: detect change scope and take the fastest path.
export async function incrementalRefresh(
  dbPath?: string,
  includeSystem = false,
): Promise<EpicResult> {
  const resolved = await workspaceTargetOptions(dbPath)
  const options: BdOptions = { ...resolved.options, includeSystem }
  const dbKey = resolved.dbPath ?? ""

  const run = () => incrementalRefreshCore(options, dbKey, includeSystem)
  return options.workspaceId ? workspaceTransition.withOperation(options.workspaceId, run) : run()
}

async function incrementalRefreshCore(
  options: BdOptions,
  dbKey: string,
  includeSystem: boolean,
): Promise<EpicResult> {
  try {
    if (
      !hasCachedResult() ||
      getCachedDbPath() !== dbKey ||
      getCachedIncludeSystem() !== includeSystem
    )
      return fullRebuild(options)

    const cachedParts = getCachedFingerprintParts()
    if (!cachedParts) return fullRebuild(options)

    const newFingerprint = await getDataFingerprint({ ...options, parallel: true })

    const cached = getCachedEpics(newFingerprint, dbKey, includeSystem)
    if (cached) {
      console.error("[epics] incremental refresh: fingerprint cache hit (no change)")
      return { success: true, epics: cached }
    }

    const newParts = parseFingerprint(newFingerprint)
    if (!newParts) {
      console.error("[epics] incremental refresh: fingerprint unparseable, full rebuild")
      return fullRebuild(options)
    }

    if (newParts.headHash !== cachedParts.headHash) {
      console.error(
        `[epics] incremental refresh: HEAD changed (${cachedParts.headHash.slice(0, 8)} -> ${newParts.headHash.slice(0, 8)}), full rebuild`,
      )
      return fullRebuild(options)
    }

    // Shape D (bb-3gnz.5 investigation): in current Dolt commit semantics
    // (every bd write produces a HEAD commit), this branch is unreachable —
    // the cache-hit miss above means the fingerprint differs, and on a
    // differing fingerprint the headHash check above will always trip
    // first. Falling to fullRebuild as the safe default preserves the
    // post-event refresh contract if a future Dolt batch-commit mode
    // lands and HEAD becomes stable across writes.
    return fullRebuild(options)
  } catch {
    try {
      return await fullRebuild(options)
    } catch (rebuildError) {
      return { success: false, bdLoadError: toBdLoadError(rebuildError) }
    }
  }
}

// Fetch blocks/dependency data separately for deferred loading.
export async function getBlocksDependencies(dbPath?: string): Promise<Record<string, string[]>> {
  const { options } = await workspaceTargetOptions(dbPath)

  try {
    const blocksDeps = await getAllBlocksDependencies(options)
    if (blocksDeps.size === 0) return {}

    const result: Record<string, string[]> = {}
    for (const [beadId, blockerIds] of blocksDeps) {
      result[beadId] = blockerIds
    }
    return result
  } catch {
    return {}
  }
}

// Get a single bead with full details
export async function getBeadDetail(id: string, dbPath?: string): Promise<Bead | null> {
  const { options, target, dbPath: resolvedPath } = await workspaceTargetOptions(dbPath)
  const run = () => getBeadDetailCore(id, options, target?.mode === "server", resolvedPath)
  return options.workspaceId ? workspaceTransition.withOperation(options.workspaceId, run) : run()
}

async function getBeadDetailCore(
  id: string,
  options: BdOptions,
  serverMode: boolean,
  resolvedPath?: string,
): Promise<Bead | null> {
  if (hasCachedResult() && getCachedDbPath() === (resolvedPath ?? "")) {
    const cached = getCachedBeadDetail(id)
    if (cached) {
      console.error(`[bd] show (cache hit) for ${id}`)
      return cached
    }
  }

  try {
    let readOptions = options
    if (serverMode) {
      readOptions = { ...options, parallel: true }
    }

    const {
      bead: bdBead,
      comments: bdComments,
      dependencies: deps,
      dependents,
    } = await readBeadDetail(id, readOptions)

    const comments = bdComments.map(convertComment)
    const bead = convertBead(bdBead, comments)

    const blockedBy = deps
      .filter((d) => d.dependency_type === "blocks")
      .map((d) => ({ id: d.id, title: d.title }))
    const blocks = dependents
      .filter((d) => d.dependency_type === "blocks")
      .map((d) => ({ id: d.id, title: d.title }))

    const result: Bead = {
      ...bead,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
      blocks: blocks.length > 0 ? blocks : undefined,
    }

    setCachedBeadDetail(result)

    return result
  } catch (error) {
    if (error instanceof ServeHttpError && error.status === 404 && error.code === "not_found")
      return null
    if (error instanceof Error && error.message === `Issue not found: ${id}`) return null
    throw error
  }
}

// Get server-side cache stats for developer mode diagnostics
export async function getCacheStats(): Promise<{
  epicCached: boolean
  epicDbPath: string | null
  epicFingerprintParts: { headHash: string; maxUpdatedAt: string; commentFp: string } | null
  beadDetailCache: { size: number; entries: Array<{ id: string; commentCount: number }> }
}> {
  return {
    epicCached: hasCachedResult(),
    epicDbPath: getCachedDbPath(),
    epicFingerprintParts: getCachedFingerprintParts(),
    beadDetailCache: getBeadDetailCacheStats(),
  }
}

/** @internal Used by tests only; no production consumers. */
export async function getBeadComments(id: string, dbPath?: string): Promise<Comment[]> {
  const { options } = await workspaceTargetOptions(dbPath)

  try {
    const bdComments = await getComments(id, options)
    return bdComments.map(convertComment)
  } catch {
    return []
  }
}
