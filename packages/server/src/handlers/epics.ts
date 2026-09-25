// Epics handler namespace. Mirrors every export of actions/epics.ts.
//
// Same name + signature + return shape parity as the actions. Internals call
// into ../lib/bd (the source-local copy). No "use server" annotation.
//
// Channel discipline: console.log calls in the original are replaced with
// console.error so they route to stderr in the sidecar (stdout is reserved
// for kkrpc frames). index.ts also redirects console.log globally as a
// belt-and-suspenders, but the explicit rewrite here documents the intent.

import { basename, dirname, resolve } from "path"
import {
  type BdBead,
  type BdComment,
  type BdOptions,
  getAllBlocksDependencies,
  getComments,
  getDataFingerprint,
  listBeads,
  listDependencies,
  listDependents,
  mapPriority,
  mapType,
  showBead,
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
  hasCachedResult,
  parseFingerprint,
  setCachedBeadDetail,
  setCachedEpics,
} from "../lib/epic-cache"
import { consumeEpicPrefetch, startEpicPrefetch } from "../lib/epic-prefetch"
import { matchRig, parseRoutes } from "../lib/routes"
import type { Bead, BeadPriority, BeadStatus, BeadType, Comment, Epic } from "../lib/types"

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
    type: (bdBead.id.includes("-mol-") && bdBead.issue_type === "epic"
      ? "molecule"
      : mapType(bdBead.issue_type)) as BeadType,
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
  const cached = getCachedEpics(currentFingerprint, dbKey)
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

  const hierarchicalTypes = new Set(["epic", "convoy"])
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
      children: children.map((child) => buildBeadWithChildren(child, depth + 1)),
    }
  }

  const epicMap = new Map<string, Epic>()
  const childEpicIds = new Set<string>()

  for (const bdEpic of epicsWithDependents) {
    const epic: Epic = {
      ...convertBead(bdEpic),
      type:
        bdEpic.issue_type === "convoy"
          ? "convoy"
          : bdEpic.id.includes("-mol-") && bdEpic.issue_type === "epic"
            ? "molecule"
            : "epic",
      children: [],
      childEpics: [],
    }
    epicMap.set(bdEpic.id, epic)
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

  // Attach rigName from routes.jsonl (Gastown multi-rig workspaces)
  const dbPath = options.db || process.cwd()
  const beadsDir = basename(resolve(dbPath)) === ".beads" ? dbPath : dirname(dbPath)
  const routes = await parseRoutes(beadsDir)
  if (routes.size > 0) {
    function attachRigNames(bead: Bead) {
      bead.rigName = matchRig(bead.id, routes)
      bead.children?.forEach(attachRigNames)
    }
    function attachRigNamesToEpic(epic: Epic) {
      attachRigNames(epic)
      epic.children?.forEach(attachRigNames)
      epic.childEpics?.forEach(attachRigNamesToEpic)
    }
    topLevelEpics.forEach(attachRigNamesToEpic)
  }

  if (currentFingerprint) {
    setCachedEpics(currentFingerprint, dbKey, topLevelEpics)
  }

  return topLevelEpics
}

// Discriminated union: structured result that crosses the kkrpc boundary
// without losing error classification (no instanceof needed).
/** @internal Used by tests only; no production consumers. */
export type EpicResult =
  | { success: true; epics: Epic[] }
  | { success: false; bdLoadError: BdLoadError }

async function getEpicsCore(dbPath?: string): Promise<EpicResult> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
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

// Get all epics with their hierarchy.
// Checks for a prefetched result first (started during health check).
export async function getEpics(dbPath?: string): Promise<EpicResult> {
  const prefetched = consumeEpicPrefetch(dbPath)
  if (prefetched) {
    console.error("[epics] using prefetched epic data")
    return prefetched
  }
  return getEpicsCore(dbPath)
}

// Start prefetching epic data.
export async function prefetchEpicData(dbPath?: string): Promise<void> {
  startEpicPrefetch(dbPath, () => getEpicsCore(dbPath))
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
export async function incrementalRefresh(dbPath?: string): Promise<EpicResult> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  const dbKey = dbPath ?? ""

  try {
    if (!hasCachedResult() || getCachedDbPath() !== dbKey) return fullRebuild(options)

    const cachedParts = getCachedFingerprintParts()
    if (!cachedParts) return fullRebuild(options)

    const newFingerprint = await getDataFingerprint({ ...options, parallel: true })

    const cached = getCachedEpics(newFingerprint, dbKey)
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
  } catch (error) {
    try {
      return await fullRebuild(options)
    } catch (rebuildError) {
      return { success: false, bdLoadError: toBdLoadError(rebuildError) }
    }
  }
}

// Fetch blocks/dependency data separately for deferred loading.
//
// `degraded` is set whenever blockedBy could NOT be computed, so the client can
// tell "nothing is blocked" apart from "we could not find out". Both used to be
// an empty object -- the swallow that hid bd's column rename from every bd >= 1.2
// user. How the UI shows a degraded result is a follow-up; the distinction
// itself is not optional.
export type BlocksDependenciesPayload = {
  blockedBy: Record<string, string[]>
  degraded?: { reason: "unsupported" | "error"; message: string }
}

export async function getBlocksDependencies(dbPath?: string): Promise<BlocksDependenciesPayload> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    const result = await getAllBlocksDependencies(options)
    if (result.status === "unsupported") {
      return { blockedBy: {}, degraded: { reason: "unsupported", message: result.reason } }
    }
    if (result.status === "error") {
      return { blockedBy: {}, degraded: { reason: "error", message: result.error.message } }
    }
    return { blockedBy: Object.fromEntries(result.map) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[epics] getBlocksDependencies failed: ${message}`)
    return { blockedBy: {}, degraded: { reason: "error", message } }
  }
}

// Get a single bead with full details
export async function getBeadDetail(id: string, dbPath?: string): Promise<Bead | null> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}

  if (hasCachedResult() && getCachedDbPath() === (dbPath ?? "")) {
    const cached = getCachedBeadDetail(id)
    if (cached) {
      console.error(`[bd] show (cache hit) for ${id}`)
      return cached
    }
  }

  try {
    let readOptions = options
    if (dbPath) {
      const mode = await readMetadataMode(dbPath)
      if (mode === "server") {
        readOptions = { ...options, parallel: true }
      }
    }

    // beadbox-a9l: comment bodies come from the dedicated, version-stable
    // `bd comments <id> --json` subcommand (getComments) rather than from
    // bd show — bd show omits bodies by default and its --include-comments
    // flag is version-gated (fails on CI's older bd). getComments runs in
    // the SAME parallel batch as showBead, so there is no added round-trip
    // vs. reading them inline; both are cheaper than the pre-b09d6ccc
    // design's serial getComments call. Falls back to an empty list so a
    // comments fetch failure never blocks the rest of the detail panel.
    const [bdBead, bdComments, deps, dependents] = await Promise.all([
      showBead(id, readOptions),
      getComments(id, readOptions).catch(() => []),
      listDependencies(id, readOptions).catch(() => []),
      listDependents(id, readOptions).catch(() => []),
    ])

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
  } catch {
    return null
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
  const options: BdOptions = dbPath ? { db: dbPath } : {}

  try {
    const bdComments = await getComments(id, options)
    return bdComments.map(convertComment)
  } catch {
    return []
  }
}
