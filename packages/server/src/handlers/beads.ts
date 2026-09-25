// Beads handler namespace. Mirrors every export of actions/beads.ts.
//
// One handler per action, identical name + signature + return shape. Internals
// call into ../lib/bd (the source-local copy). No "use server" annotation —
// these are kkrpc methods, not Next.js server actions.
//
// Channel discipline note: index.ts redirects console.log/console.debug to
// stderr at sidecar boot, so it's safe to retain console.error calls verbatim
// from the action source.

import { readFile } from "fs/promises"
import { homedir, tmpdir } from "os"
import { basename, dirname, extname, isAbsolute, relative, resolve } from "path"

import {
  type BdOptions,
  addComment as bdAddComment,
  addLabel as bdAddLabel,
  closeBead as bdCloseBead,
  deleteBead as bdDeleteBead,
  deleteComment as bdDeleteComment,
  getCustomStatuses as bdGetCustomStatuses,
  getAvailableTypes as bdGetAvailableTypes,
  removeDependency as bdRemoveDependency,
  removeLabel as bdRemoveLabel,
  setCustomStatuses as bdSetCustomStatuses,
  showBead as bdShowBead,
  updateAssignee as bdUpdateAssignee,
  updateDefer as bdUpdateDefer,
  updateDesign as bdUpdateDesign,
  updateDue as bdUpdateDue,
  updateEstimate as bdUpdateEstimate,
  updateParent as bdUpdateParent,
  updatePriority as bdUpdatePriority,
  updateSpecId as bdUpdateSpecId,
  updateStatus as bdUpdateStatus,
  updateTitle as bdUpdateTitle,
  updateType as bdUpdateType,
  unmapPriority,
} from "../lib/bd"
import { readMetadataMode } from "../lib/dolt-metadata"
import { invalidateEpicCache } from "../lib/epic-cache"
import { RESERVED_STATUSES, validateStatusName } from "../lib/status-validation"
import type { BeadPriority, BeadType } from "../lib/types"

// Update bead status
export async function updateBeadStatus(
  id: string,
  status: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateStatus(id, status, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update status:", error)
    return { success: false, error: String(error) }
  }
}

// Get all available statuses (core + custom)
export async function getAvailableStatuses(dbPath?: string): Promise<string[]> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  if (dbPath) {
    const mode = await readMetadataMode(dbPath)
    if (mode === "server") {
      options.parallel = true
    }
  }
  const coreStatuses = ["open", "in_progress", "closed"]

  try {
    const customStatuses = await bdGetCustomStatuses(options)
    return [...coreStatuses, ...customStatuses]
  } catch {
    return coreStatuses
  }
}

// `bd types` reflects the selected workspace's types.custom configuration.
// An older bd cannot provide an accurate list of valid edit targets.
export async function getAvailableTypes(dbPath?: string): Promise<string[]> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  if (dbPath && (await readMetadataMode(dbPath)) === "server") {
    // bd types only reads the catalog. Server-mode reads can run alongside
    // detail requests instead of waiting behind their per-db CLI queue.
    options.parallel = true
  }
  try {
    return await bdGetAvailableTypes(options)
  } catch (error) {
    const message = `${(error as { stderr?: string }).stderr ?? ""} ${String(error)}`
    if (/unknown command\s+["']?types["']?/i.test(message)) {
      throw new Error("The installed bd does not support `bd types`; upgrade bd to edit issue types", { cause: error })
    }
    throw error
  }
}

// Get only the custom statuses (for the Settings → Workflow manager). Distinct
// from getAvailableStatuses, which prepends the core lifecycle statuses.
// Ported from v0.24 actions/beads.ts (commit 1386b41 / bb-oqux) for bb-wxuw.
export async function getCustomStatusList(dbPath?: string): Promise<string[]> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    return await bdGetCustomStatuses(options)
  } catch {
    return []
  }
}

// Replace the custom-status list. Validates each entry server-side as a
// defence-in-depth layer: client validation is the primary gate, but a
// malformed client payload must never write garbage to status.custom.
// Ported from v0.24 actions/beads.ts (commit 1386b41 / bb-oqux) for bb-wxuw.
export async function updateCustomStatuses(
  statuses: string[],
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const cleaned = statuses.map((s) => s.trim()).filter(Boolean)
  const seen = new Set<string>()
  for (let i = 0; i < cleaned.length; i++) {
    const name = cleaned[i]
    if (seen.has(name)) {
      return { success: false, error: `Duplicate status '${name}'` }
    }
    // Validate against the already-accepted prefix so the error points at
    // the offending entry without flagging its own prior appearance as a dupe.
    const err = validateStatusName(name, cleaned.slice(0, i))
    if (err) return { success: false, error: err }
    seen.add(name)
  }

  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdSetCustomStatuses(cleaned, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update custom statuses:", error)
    return { success: false, error: String(error) }
  }
}

// Re-export for tests + tooling that need the reserved-list constant via the
// handler's surface (defence-in-depth audits, etc.).
export { RESERVED_STATUSES }

// Update bead priority
export async function updateBeadPriority(
  id: string,
  priority: BeadPriority,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdatePriority(id, unmapPriority(priority), options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update priority:", error)
    return { success: false, error: String(error) }
  }
}

// Update bead assignee
export async function updateBeadAssignee(
  id: string,
  assignee: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateAssignee(id, assignee, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update assignee:", error)
    return { success: false, error: String(error) }
  }
}

// Update bead spec_id
export async function updateBeadSpecId(
  id: string,
  specId: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateSpecId(id, specId, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update spec_id:", error)
    return { success: false, error: String(error) }
  }
}

// Update bead title
export async function updateBeadTitle(
  id: string,
  title: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateTitle(id, title, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update title:", error)
    return { success: false, error: String(error) }
  }
}

// Update bead type
export async function updateBeadType(
  id: string,
  type: BeadType,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateType(id, type, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update type:", error)
    return { success: false, error: String(error) }
  }
}

// Close a bead
export async function closeBead(
  id: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdCloseBead(id, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to close bead:", error)
    return { success: false, error: String(error) }
  }
}

// Add a comment to a bead
export async function addComment(
  id: string,
  text: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdAddComment(id, text, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to add comment:", error)
    return { success: false, error: String(error) }
  }
}

// Delete a comment
export async function deleteCommentAction(
  commentId: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!dbPath) {
    return { success: false, error: "Database path required" }
  }
  const options: BdOptions = { db: dbPath }
  try {
    await bdDeleteComment(commentId, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to delete comment:", error)
    return { success: false, error: String(error) }
  }
}

// Update bead parent (move to different epic or standalone)
export async function updateBeadParent(
  id: string,
  parentId: string | null,
  dbPath?: string,
): Promise<{ success: boolean; error?: string; alreadyLinked?: boolean }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateParent(id, parentId, options)
    return { success: true }
  } catch (error) {
    // bb-ijuq (ported from main 977f8fd via bb-qyxr) defense-in-depth: bd
    // rejects duplicate-dependency edges with an "already exists" error.
    // The hook's pre-call guard (use-bead-actions.ts handleBeadMove)
    // catches the common case; this catches programmatic / future call
    // sites that bypass the hook. Soft-success with alreadyLinked: true
    // so the caller can treat it as a no-op without parsing error strings.
    // Forgiving regex over an exact-string match — the bd error format
    // isn't a stable contract.
    const msg = String(error)
    if (/already exists/i.test(msg)) {
      return { success: true, alreadyLinked: true }
    }
    console.error("Failed to update parent:", error)
    return { success: false, error: msg }
  }
}

// Delete a bead
export async function deleteBead(
  id: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!dbPath) {
    return { success: false, error: "Database path required" }
  }
  const options: BdOptions = { db: dbPath }
  try {
    await bdDeleteBead(id, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to delete bead:", error)
    return { success: false, error: String(error) }
  }
}

// Archive or unarchive a bead
export async function archiveBead(
  id: string,
  archived: boolean,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    if (archived) {
      await bdAddLabel(id, "archived", options)
    } else {
      await bdRemoveLabel(id, "archived", options)
    }
    invalidateEpicCache()
    return { success: true }
  } catch (error) {
    console.error("Failed to archive bead:", error)
    return { success: false, error: String(error) }
  }
}

// bb-y729: Bulk-archive a list of bead ids. Loops over the existing
// per-bead `bd update <id> --add-label archived` path; bd's --add-label is
// additive so prior labels are preserved without explicit merge logic on
// our side. Returns per-id status so the client can revert optimistic UI
// only on the failed rows.
export async function archiveBeads(
  ids: string[],
  dbPath?: string,
): Promise<{
  success: boolean
  results: { id: string; success: boolean; error?: string }[]
}> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  const results: { id: string; success: boolean; error?: string }[] = []
  for (const id of ids) {
    try {
      await bdAddLabel(id, "archived", options)
      results.push({ id, success: true })
    } catch (error) {
      console.error(`Failed to archive bead ${id}:`, error)
      results.push({ id, success: false, error: String(error) })
    }
  }
  if (ids.length > 0) {
    invalidateEpicCache()
  }
  return { success: results.every((r) => r.success), results }
}

// Move a bead to or from backlog by setting priority
export async function backlogBead(
  id: string,
  inBacklog: boolean,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    const priority = inBacklog ? unmapPriority("backlog") : unmapPriority("medium")
    await bdUpdatePriority(id, priority, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update backlog status:", error)
    return { success: false, error: String(error) }
  }
}

// Add a label to a bead
export async function addLabelAction(
  id: string,
  label: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdAddLabel(id, label, options)
    invalidateEpicCache()
    return { success: true }
  } catch (error) {
    console.error("Failed to add label:", error)
    return { success: false, error: String(error) }
  }
}

// Update bead due date
export async function updateBeadDue(
  id: string,
  due: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateDue(id, due, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update due date:", error)
    return { success: false, error: String(error) }
  }
}

// Update bead defer date
export async function updateBeadDefer(
  id: string,
  defer: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateDefer(id, defer, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update defer date:", error)
    return { success: false, error: String(error) }
  }
}

// Update bead estimated minutes
export async function updateBeadEstimate(
  id: string,
  est: number,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateEstimate(id, est, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update estimate:", error)
    return { success: false, error: String(error) }
  }
}

// Update bead design
export async function updateBeadDesign(
  id: string,
  design: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdUpdateDesign(id, design, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to update design:", error)
    return { success: false, error: String(error) }
  }
}

// Remove a dependency between two beads
export async function removeDependencyAction(
  issueId: string,
  dependsOnId: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdRemoveDependency(issueId, dependsOnId, options)
    return { success: true }
  } catch (error) {
    console.error("Failed to remove dependency:", error)
    return { success: false, error: String(error) }
  }
}

// Close multiple beads (used when closing an epic with its children)
export async function closeBeadChildren(
  ids: string[],
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    for (const id of ids) {
      await bdCloseBead(id, options)
    }
    return { success: true }
  } catch (error) {
    console.error("Failed to close children:", error)
    return { success: false, error: String(error) }
  }
}

// Archive multiple beads (used when archiving an epic with its children)
export async function archiveBeadChildren(
  ids: string[],
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    for (const id of ids) {
      await bdAddLabel(id, "archived", options)
    }
    return { success: true }
  } catch (error) {
    console.error("Failed to archive children:", error)
    return { success: false, error: String(error) }
  }
}

// Check if a bead exists (returns true if found, false if deleted/not found)
export async function checkBeadExists(id: string, dbPath?: string): Promise<boolean> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdShowBead(id, options)
    return true
  } catch {
    return false
  }
}

// Remove a label from a bead
export async function removeLabelAction(
  id: string,
  label: string,
  dbPath?: string,
): Promise<{ success: boolean; error?: string }> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  try {
    await bdRemoveLabel(id, label, options)
    invalidateEpicCache()
    return { success: true }
  } catch (error) {
    console.error("Failed to remove label:", error)
    return { success: false, error: String(error) }
  }
}

// Check if a path is within allowed base directories
function isSpecPathAllowed(targetPath: string): boolean {
  const normalizedTarget = resolve(targetPath)
  if (targetPath.includes("\0")) return false

  const allowedDirs = [homedir(), process.cwd(), tmpdir()]
  for (const baseDir of allowedDirs) {
    const normalizedBase = resolve(baseDir)
    const rel = relative(normalizedBase, normalizedTarget)
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return true
    }
  }
  return false
}

// Derive workspace root from databasePath.
// .beads/ directory -> parent. .beads/beads.db -> grandparent.
function workspaceRootFromDbPath(dbPath: string): string {
  const resolved = resolve(dbPath)
  if (basename(resolved) === ".beads") {
    return dirname(resolved)
  }
  // .beads/beads.db -> strip two levels
  return dirname(dirname(resolved))
}

// Read a spec file from disk given a relative spec path and workspace databasePath
export async function readSpecFile(
  specPath: string,
  databasePath: string,
): Promise<{ success: true; content: string } | { success: false; error: string }> {
  if (!specPath || !databasePath) {
    return { success: false, error: "Missing spec path or database path" }
  }

  // Only allow .md files
  if (extname(specPath).toLowerCase() !== ".md") {
    return { success: false, error: "Only markdown (.md) files can be viewed" }
  }

  // Resolve spec path relative to workspace root
  const workspaceRoot = workspaceRootFromDbPath(databasePath)
  const absolutePath = resolve(workspaceRoot, specPath)

  // Validate path is within allowed directories
  if (!isSpecPathAllowed(absolutePath)) {
    return { success: false, error: "File path is outside allowed directories" }
  }

  try {
    const content = await readFile(absolutePath, "utf-8")
    return { success: true, content }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return { success: false, error: `File not found: ${specPath}` }
    }
    if (code === "EACCES") {
      return { success: false, error: `Permission denied: ${specPath}` }
    }
    return { success: false, error: `Could not read spec file: ${specPath}` }
  }
}
