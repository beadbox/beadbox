// kkrpc handler mirror of actions/workspaces.ts (P1.3 / bb-vy13.3).
//
// Parity contract: every export of actions/workspaces.ts is mirrored here
// with identical signatures and return shapes. Body is structurally
// identical to the action; only "use server" and the @/lib import aliases
// are removed.
//
// The old action keeps running. P3 will switch call sites to this handler;
// P6 will delete the action.

import { randomUUID } from "node:crypto"
import { constants, existsSync, readdirSync } from "node:fs"
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path"
import {
  discoverServerDatabases as bdDiscoverServerDatabases,
  initWorkspace as bdInit,
  setWorkspacePassword as bdSetWorkspacePassword,
  getWorkspaceStatus,
  initServerScaffold,
} from "../lib/bd"
import { drainPool } from "../lib/dolt-pool"
import { ensureExternalScaffold } from "../lib/external-scaffold"
import { expandHome, isValidWorkspaceDir } from "../lib/path-validation"
import { scanPorts } from "../lib/port-scan"
import { getPostHogNode } from "../lib/posthog-node"
import type { ScanResult, ServerDatabase, Workspace, WorkspaceCard } from "../lib/types"
import {
  addServerWorkspaceEntry,
  findWorkspace,
  findWorkspaceByDbPath,
  getBeadboxRegistryPath,
  getServerOwnership,
  projectDirFromDatabasePath,
  type RegistryEntry,
  readRegistry,
  readWorkspacePortFile,
  addWorkspace as registryAddWorkspace,
  replaceWorkspace as registryReplaceWorkspace,
  setActiveWorkspace as registrySetActiveWorkspace,
  removeWorkspaceFromRegistry,
  type ServerConnection,
  updateWorkspaceLabel,
  updateWorkspaceLocal,
  updateWorkspaceServer,
} from "../lib/workspace-registry"
import { workspaceTransition } from "../lib/workspace-transition"

// Server-side workspace logging. Prints to the Next.js terminal.
function wsLog(fn: string, ...args: unknown[]) {
  console.log(`[ws:${fn}]`, ...args)
}

// ---------------------------------------------------------------------------
// Inlined workspace detection (avoids importing @/lib/db which hangs under
// Turbopack SSR on Windows). Mirrors lib/db.ts with cross-platform path fixes.
// ---------------------------------------------------------------------------

interface InlineWorkspace {
  id: string
  name: string
  icon?: string
  path: string | null
  databasePath: string
  registered?: boolean
  serverOnly?: boolean
  mode: "embedded" | "server"
  serverHost?: string
  serverPort?: number
  serverDatabase?: string
  serverUser?: string
  serverTls?: boolean
}

interface InlineWorkspaceModeInfo {
  mode: "embedded" | "server"
  serverHost?: string
  serverPort?: number
  serverDatabase?: string
  serverUser?: string
  serverTls?: boolean
  metadataWarning?: string
}

async function inlineReadWorkspaceMode(beadsDir: string): Promise<InlineWorkspaceModeInfo> {
  try {
    const metaPath = join(beadsDir, "metadata.json")
    const content = await readFile(metaPath, "utf-8")
    const meta = JSON.parse(content)

    if (meta.dolt_mode === "server") {
      return {
        mode: "server",
        serverHost: typeof meta.dolt_server_host === "string" ? meta.dolt_server_host : "127.0.0.1",
        serverPort:
          typeof meta.dolt_server_port === "number"
            ? meta.dolt_server_port
            : ((await readWorkspacePortFile(beadsDir)) ?? 3307),
        serverDatabase: typeof meta.dolt_database === "string" ? meta.dolt_database : "beads",
        serverUser: typeof meta.dolt_server_user === "string" ? meta.dolt_server_user : "root",
        serverTls: meta.dolt_server_tls === true,
      }
    }

    return { mode: "embedded" }
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { mode: "embedded" }
    }
    return {
      mode: "embedded",
      metadataWarning:
        "metadata.json exists but could not be parsed. Falling back to embedded detection.",
    }
  }
}

function inlineBeadsDirFromDatabasePath(dbPath: string): string {
  if (basename(resolve(dbPath)) === ".beads") return dbPath
  return dirname(dbPath)
}

function getAllowedBaseDirs(): string[] {
  return [homedir(), process.cwd(), tmpdir()]
}

function isPathWithinAllowedDirs(targetPath: string): boolean {
  const normalizedTarget = resolve(targetPath)
  if (targetPath.includes("\0")) return false
  for (const baseDir of getAllowedBaseDirs()) {
    const normalizedBase = resolve(baseDir)
    const relativePath = relative(normalizedBase, normalizedTarget)
    if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
      return true
    }
  }
  return false
}

function isValidWorkspacePath(wsPath: string): boolean {
  if (wsPath.endsWith(".db")) return isPathWithinAllowedDirs(wsPath)
  if (basename(wsPath) === ".beads" || basename(resolve(wsPath)) === ".beads") {
    return isPathWithinAllowedDirs(wsPath)
  }
  return false
}

// bb-fe03.5: the registry-entry resolver was inlined as a 50-line async
// arrow inside .map(...). Splitting the server-only and local branches
// into named helpers makes the per-entry shape testable and keeps the
// orchestrator small.

function resolveServerOnlyEntry(entry: RegistryEntry): InlineWorkspace {
  // Caller has already verified entry.local === null && entry.server is non-null.
  const server = entry.server!
  return {
    id: entry.id,
    name: entry.name,
    icon: entry.icon,
    path: null,
    databasePath: `server://${server.host}:${server.port}/${server.database}`,
    registered: true,
    serverOnly: true,
    mode: "server" as const,
    serverHost: server.host,
    serverPort: server.port,
    serverDatabase: server.database,
    serverUser: server.user,
    serverTls: server.tls,
  }
}

async function migrateStaleDbPath(dbPath: string, beadsDir: string): Promise<string> {
  // .db file paths from old SQLite-era registries: if the file no longer
  // exists but the parent .beads/ is a Dolt workspace, return the .beads
  // path so callers operate on the Dolt directory.
  if (!dbPath.endsWith(".db")) return dbPath
  try {
    await access(dbPath, constants.R_OK)
    return dbPath
  } catch {
    if (await inlineIsDoltWorkspace(beadsDir)) return beadsDir
    return dbPath
  }
}

function formatResolveLog(name: string, dbPath: string, modeInfo: InlineWorkspaceModeInfo): string {
  const serverSuffix = modeInfo.serverPort
    ? ` server=${modeInfo.serverHost}:${modeInfo.serverPort}/${modeInfo.serverDatabase}`
    : ""
  return `local "${name}" → db=${dbPath} mode=${modeInfo.mode}${serverSuffix}`
}

async function resolveLocalEntry(entry: RegistryEntry): Promise<InlineWorkspace> {
  let dbPath = entry.local!.path
  const beadsDir = inlineBeadsDirFromDatabasePath(dbPath)
  dbPath = await migrateStaleDbPath(dbPath, beadsDir)

  const projectDir = projectDirFromDatabasePath(dbPath)
  const modeInfo =
    getServerOwnership(entry) === "external" && entry.server
      ? {
          mode: "server" as const,
          serverHost: entry.server.host,
          serverPort: entry.server.port,
          serverDatabase: entry.server.database,
          serverUser: entry.server.user,
          serverTls: entry.server.tls,
        }
      : await inlineReadWorkspaceMode(beadsDir)
  wsLog("resolve", formatResolveLog(entry.name, dbPath, modeInfo))
  return {
    id: entry.id,
    name: entry.name || basename(projectDir),
    icon: entry.icon,
    path: projectDir,
    databasePath: dbPath,
    registered: true,
    ...modeInfo,
  }
}

async function resolveRegistryEntry(entry: RegistryEntry): Promise<InlineWorkspace> {
  if (entry.local === null && entry.server) return resolveServerOnlyEntry(entry)
  return resolveLocalEntry(entry)
}

// Every caller that returns a workspace to the client maps it here. The
// hand-written copies drifted: updateServerConnection built its card without
// `icon`, so reconfiguring a server connection cleared the workspace's emoji
// in client state.
function toWorkspace(resolved: InlineWorkspace, available: boolean): Workspace {
  return {
    id: resolved.id,
    name: resolved.name,
    icon: resolved.icon,
    path: resolved.path,
    databasePath: resolved.databasePath,
    registered: resolved.registered ?? false,
    available,
    mode: resolved.mode,
    serverHost: resolved.serverHost,
    serverPort: resolved.serverPort,
    serverDatabase: resolved.serverDatabase,
    serverUser: resolved.serverUser,
    serverTls: resolved.serverTls,
  }
}

async function inlineGetRegisteredWorkspaces(): Promise<InlineWorkspace[]> {
  try {
    const registry = await readRegistry()
    return await Promise.all(registry.workspaces.map(resolveRegistryEntry))
  } catch {
    return []
  }
}

async function inlineGetDefaultDbPath(): Promise<string | null> {
  const beadsHome = join(homedir(), ".beads")
  if (await inlineIsDoltWorkspace(beadsHome)) return beadsHome
  const defaultPath = join(beadsHome, "default.db")
  try {
    await access(defaultPath, constants.R_OK)
    return defaultPath
  } catch {
    return null
  }
}

async function inlineIsDoltWorkspace(beadsDir: string): Promise<boolean> {
  // bd < 0.63: dolt/, bd >= 0.63: embeddeddolt/
  for (const dir of ["dolt", "embeddeddolt"]) {
    try {
      const s = await stat(join(beadsDir, dir))
      if (s.isDirectory()) return true
    } catch {
      /* not found */
    }
  }
  try {
    const metaPath = join(beadsDir, "metadata.json")
    const content = await readFile(metaPath, "utf-8")
    const meta = JSON.parse(content)
    if (meta.backend === "dolt") return true
  } catch {
    /* no metadata */
  }
  return false
}

// Check whether the database backing a workspace path actually exists.
// For .beads/ directory paths: dolt/ subdir (Dolt) or beads.db file (SQLite).
// For .db file paths: the file itself.
async function databaseExists(dbPath: string): Promise<boolean> {
  const resolved = resolve(dbPath)
  if (basename(resolved) === ".beads") {
    // Dolt workspace: dolt/ (bd < 0.63), embeddeddolt/ (bd >= 0.63), or beads.db (SQLite)
    for (const sub of ["dolt", "embeddeddolt", "beads.db"]) {
      try {
        await stat(join(resolved, sub))
        return true
      } catch {
        /* not found */
      }
    }
    return false
  }
  // SQLite .db file: check file exists
  try {
    await access(resolved, constants.R_OK)
    return true
  } catch {
    return false
  }
}

// Dead code in actions/workspaces.ts (no callers). Mirrored verbatim for
// parity; void-consume satisfies sidecar tsconfig's noUnusedLocals.
function inlineProjectDirFromWorkspacePath(wsPath: string): string {
  if (basename(resolve(wsPath)) === ".beads") return dirname(wsPath)
  return dirname(dirname(wsPath))
}
void inlineProjectDirFromWorkspacePath

async function inlineFindNearestBeadsDir(startPath: string): Promise<string | null> {
  if (!isPathWithinAllowedDirs(startPath)) return null
  let current = resolve(startPath)
  while (current !== parse(current).root && isPathWithinAllowedDirs(current)) {
    const beadsDir = join(current, ".beads")
    if (!isPathWithinAllowedDirs(beadsDir)) {
      current = dirname(current)
      continue
    }
    try {
      const stats = await stat(beadsDir)
      if (stats.isDirectory()) {
        // Check for Dolt workspace first
        if (await inlineIsDoltWorkspace(beadsDir)) {
          if (isValidWorkspacePath(beadsDir)) return beadsDir
        }
        // Fall back to SQLite
        const { readdir } = await import("node:fs/promises")
        const files = await readdir(beadsDir)
        const dbFile = files.find((f) => f.endsWith(".db") && !f.includes("/") && !f.includes("\\"))
        if (dbFile) {
          const dbPath = join(beadsDir, dbFile)
          if (isValidWorkspacePath(dbPath)) return dbPath
        }
      }
    } catch {
      // Directory doesn't exist, continue walking up
    }
    current = dirname(current)
  }
  return null
}

async function inlineDetectWorkspaces(): Promise<InlineWorkspace[]> {
  // Registry-only: no CWD scanning, no default db scanning.
  // The app owns which workspaces appear via ~/.beadbox/registry.json.
  const workspaces: InlineWorkspace[] = []
  const seenPaths = new Set<string>()

  const registered = await inlineGetRegisteredWorkspaces()
  for (const ws of registered) {
    if (!seenPaths.has(ws.databasePath)) {
      workspaces.push(ws)
      seenPaths.add(ws.databasePath)
    }
  }

  return workspaces
}

// Dead code in actions/workspaces.ts (no callers). Mirrored verbatim for
// parity; void-consume below satisfies sidecar tsconfig's noUnusedLocals.
async function inlineResolveDbPath(explicitPath?: string, cwd?: string): Promise<string | null> {
  if (explicitPath) {
    const resolvedPath = resolve(explicitPath)
    if (!isValidWorkspacePath(resolvedPath)) return null
    try {
      await access(resolvedPath, constants.R_OK)
      return resolvedPath
    } catch {
      return null
    }
  }

  const envPath = process.env.BEADS_DB
  if (envPath) {
    const resolvedEnvPath = resolve(envPath)
    if (isValidWorkspacePath(resolvedEnvPath)) {
      try {
        await access(resolvedEnvPath, constants.R_OK)
        return resolvedEnvPath
      } catch {
        // env path not accessible
      }
    }
  }

  const startPath = cwd || process.cwd()
  const nearestDb = await inlineFindNearestBeadsDir(startPath)
  if (nearestDb) return nearestDb

  return inlineGetDefaultDbPath()
}
void inlineResolveDbPath

// ---------------------------------------------------------------------------
// Registry write: persist workspace to ~/.beadbox/registry.json
// ---------------------------------------------------------------------------

async function registerWorkspace(workspacePath: string, databasePath: string): Promise<string> {
  const name = basename(resolve(workspacePath))
  return registryAddWorkspace(resolve(databasePath), name)
}

// ---------------------------------------------------------------------------
// Exported server actions
// ---------------------------------------------------------------------------

// Get all available workspaces from the beadbox registry.
// No filesystem autodiscovery or cookie fallback - registry is the source of truth.
export async function getWorkspaces(savedDatabasePath?: string): Promise<Workspace[]> {
  // Parameter retained for signature parity with actions/workspaces.ts; the
  // original action ignores it (registry is the source of truth).
  void savedDatabasePath
  const workspaces = await inlineDetectWorkspaces()

  const results: Workspace[] = []
  for (const ws of workspaces) {
    // Server-only workspaces are available by definition (reachability checked at connect time)
    const available = ws.serverOnly ? true : await databaseExists(ws.databasePath)
    results.push(toWorkspace(ws, available))
  }

  return results
}

// Get workspaces from registry only (no filesystem probing beyond ~/.beads/)
// Used by the workspace selector screen to avoid macOS TCC prompts on launch
export async function getRegisteredWorkspacesForSelector(): Promise<WorkspaceCard[]> {
  const registered = await inlineGetRegisteredWorkspaces()
  const results: WorkspaceCard[] = []
  for (const ws of registered) {
    const available = ws.serverOnly ? true : await databaseExists(ws.databasePath)
    // WorkspaceCard narrows path/databasePath to non-optional; the mapper
    // returns them as the wider Workspace fields.
    results.push({ ...toWorkspace(ws, available), path: ws.path, databasePath: ws.databasePath })
  }
  return results
}

/** @internal Used by tests only; no production consumers. */
export async function getWorkspaceCardStats(
  dbPath: string,
): Promise<{ open: number; inProgress: number; error?: boolean; errorMessage?: string }> {
  try {
    const summary = await getWorkspaceStatus({ db: dbPath })
    return {
      open: summary.open_issues,
      inProgress: summary.in_progress_issues,
    }
  } catch (err) {
    const execErr = err as { message?: string; stderr?: string; code?: string }
    const msg = execErr.stderr || execErr.message || "Unknown error"
    return { open: 0, inProgress: 0, error: true, errorMessage: msg }
  }
}

// Add a workspace by filesystem path
// Returns the workspace card if successful, or an error message
export async function addWorkspaceByPath(
  dirPath: string,
): Promise<
  | { success: true; workspace: WorkspaceCard }
  | { success: false; error: string; needsInit?: boolean }
> {
  // Expand ~ on the server where homedir() is available (client-side process.env.HOME is undefined)
  const resolvedDir = expandHome(dirPath)

  // beadbox-l5i.3: the path arrives from the client. Gate it before it
  // reaches stat()/join()/bd so a relative path can't resolve against
  // whatever cwd the sidecar inherited, and a NUL byte can't reach a syscall.
  if (!isValidWorkspaceDir(resolvedDir)) {
    return { success: false, error: "Invalid workspace path. Provide an absolute directory path." }
  }

  // Check that the path itself exists and is a directory before looking for .beads/
  try {
    const dirStat = await stat(resolvedDir)
    if (!dirStat.isDirectory()) {
      return { success: false, error: "Path is not a directory." }
    }
  } catch {
    return { success: false, error: "Path does not exist." }
  }

  const beadsDir = join(resolvedDir, ".beads")
  const hasBeads = existsSync(beadsDir)

  if (!hasBeads) {
    // Check for spaces in folder name before offering init.
    // Dolt uses the folder name as the database name and rejects spaces.
    const folderName = basename(resolvedDir)
    if (/\s/.test(folderName)) {
      return {
        success: false,
        error: "Folder name cannot contain spaces. Rename the folder and try again.",
      }
    }
    return {
      success: false,
      error: "No workspace found here.",
      needsInit: true,
    }
  }

  // Determine workspace path: Dolt uses .beads/ directory, SQLite uses .beads/*.db file
  let wsPath: string
  const isDolt = await inlineIsDoltWorkspace(beadsDir)
  if (isDolt) {
    wsPath = beadsDir
  } else {
    let dbFile: string | null = null
    try {
      const files = readdirSync(beadsDir) as string[]
      dbFile = files.find((f: string) => f.endsWith(".db") && !f.includes("/")) || null
    } catch {
      return { success: false, error: "Could not read workspace directory." }
    }
    if (!dbFile) {
      return { success: false, error: "No database found in .beads/ directory." }
    }
    wsPath = join(beadsDir, dbFile)
  }

  const name = basename(resolvedDir)

  wsLog("addByPath", `path=${resolvedDir} wsPath=${wsPath} name=${name} isDolt=${isDolt}`)

  // Persist to ~/.beadbox/registry.json so the workspace survives restarts
  const workspaceId = await registerWorkspace(resolvedDir, wsPath)

  const modeInfo = await inlineReadWorkspaceMode(beadsDir)

  // Backfill server block for local workspaces operating in server mode.
  // registryAddWorkspace() always creates entries with server: null; if
  // metadata.json says dolt_mode=server, populate the server connection
  // so downstream code (health checks, error messages) can read it.
  if (
    modeInfo.mode === "server" &&
    modeInfo.serverHost &&
    modeInfo.serverPort &&
    modeInfo.serverDatabase
  ) {
    await updateWorkspaceServer(workspaceId, {
      host: modeInfo.serverHost,
      port: modeInfo.serverPort,
      database: modeInfo.serverDatabase,
      user: modeInfo.serverUser ?? "root",
      tls: modeInfo.serverTls ?? false,
    })
  }

  return {
    success: true,
    workspace: {
      id: workspaceId,
      name,
      path: resolvedDir,
      databasePath: wsPath,
      ...modeInfo,
    },
  }
}

// Error categories for workspace initialization failures
// Note: no "exists" category. addWorkspaceByPath() checks for existing .beads/
// directories before initializeWorkspace() is called, so duplicate detection
// is handled upstream and never reaches classifyInitError().
type InitErrorCategory = "permission" | "dolt-down" | "spaces" | "unknown"

interface InitError {
  success: false
  error: string
  category: InitErrorCategory
  fixCommand?: string
}

function classifyInitError(
  msg: string,
  stderr?: string,
): { category: InitErrorCategory; error: string; fixCommand?: string } {
  const combined = `${msg}\n${stderr ?? ""}`.toLowerCase()

  if (
    combined.includes("permission denied") ||
    combined.includes("eacces") ||
    combined.includes("eperm")
  ) {
    return {
      category: "permission",
      error: "Cannot create workspace here. Check directory permissions.",
      fixCommand: "ls -la",
    }
  }

  if (
    combined.includes("server unreachable") ||
    combined.includes("connection refused") ||
    combined.includes("dolt server") ||
    combined.includes("connect econnrefused")
  ) {
    return {
      category: "dolt-down",
      error: "Dolt must be running to create a workspace.",
      fixCommand: "bd dolt start",
    }
  }

  return {
    category: "unknown",
    error: msg || "An unknown error occurred.",
  }
}

// Check if a thrown error indicates Dolt server is down (for retry logic).
// Matches the same patterns as classifyInitError's dolt-down category.
function isDoltDownError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const stderr = (error as { stderr?: string })?.stderr ?? ""
  const combined = `${msg}\n${stderr}`.toLowerCase()
  return (
    combined.includes("server unreachable") ||
    combined.includes("connection refused") ||
    combined.includes("dolt server") ||
    combined.includes("connect econnrefused")
  )
}

// Retry an async operation with linear backoff when Dolt server is still starting.
// Used by initializeWorkspace to handle the race between app launch and Dolt auto-start.
async function retryOnDoltDown<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelayMs = 2000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt > maxRetries || !isDoltDownError(error)) throw error
      console.log(
        `[workspace-init] Dolt not ready (attempt ${attempt}/${maxRetries}), retrying in ${baseDelayMs * attempt}ms...`,
      )
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt))
    }
  }
}

// bd init writes metadata.json without dolt_server_port. Without that field,
// bd --db path resolution defaults the database name to "beads" instead of
// reading dolt_database from metadata. Parse the port from init output and
// patch metadata so subsequent bd --db calls resolve correctly.
async function ensureMetadataPort(dir: string, initOutput: string): Promise<void> {
  const metaPath = join(dir, ".beads", "metadata.json")
  try {
    const content = await readFile(metaPath, "utf-8")
    const meta = JSON.parse(content)
    if (typeof meta.dolt_server_port === "number") return

    // Parse port from bd init output: "Server: root@127.0.0.1:3307"
    const match = initOutput.match(/Server:\s+\S+@[\w.-]+:(\d+)/)
    if (!match) return

    const port = parseInt(match[1], 10)
    if (port > 0 && port <= 65535) {
      meta.dolt_server_port = port
      await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    }
  } catch {
    // Non-critical: workspace may still work via CWD auto-discovery
  }
}

// Initialize a new workspace in a directory
export async function initializeWorkspace(
  dirPath: string,
): Promise<{ success: true; workspace: WorkspaceCard } | InitError> {
  // Expand ~ on the server where homedir() is available
  const resolvedDir = expandHome(dirPath)

  // beadbox-l5i.3: same client-supplied-path gate as addWorkspaceByPath —
  // this one additionally becomes bd init's working directory.
  if (!isValidWorkspaceDir(resolvedDir)) {
    return {
      success: false,
      error: "Invalid workspace path. Provide an absolute directory path.",
      category: "unknown" as InitErrorCategory,
    }
  }

  // Dolt uses the folder name as the database name and rejects spaces
  const folderName = basename(resolvedDir)
  if (/\s/.test(folderName)) {
    return {
      success: false,
      error: "Workspace folder name cannot contain spaces. Rename the folder and try again.",
      category: "spaces",
    }
  }

  // If .beads/ already exists, add the workspace instead of re-initializing
  const beadsDir = join(resolvedDir, ".beads")
  if (existsSync(beadsDir)) {
    const addResult = await addWorkspaceByPath(resolvedDir)
    if (addResult.success) return addResult
    return { success: false, error: addResult.error, category: "unknown" as InitErrorCategory }
  }

  try {
    // bd init can observe the installed version and advance schemas. Drain old
    // serve processes before invoking the binary, even for a new directory.
    await workspaceTransition.preflightBdBinary()
    // Race bdInit against a timeout so the UI never hangs indefinitely.
    // The pre-flight Dolt check in the dialog catches the common case (Dolt missing),
    // but bd init can also hang if Dolt exists but the server never starts.
    // CI environments are slower to start Dolt, so use a longer timeout there.
    const INIT_TIMEOUT_MS = process.env.CI ? 45_000 : 15_000
    const initOutput = await Promise.race([
      retryOnDoltDown(() => bdInit(resolvedDir), 2, 2000),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Workspace initialization timed out. Dolt may not be installed or the database server failed to start.",
              ),
            ),
          INIT_TIMEOUT_MS,
        ),
      ),
    ])
    await ensureMetadataPort(resolvedDir, initOutput)
    // After init, try to find the workspace
    const result = await addWorkspaceByPath(resolvedDir)
    if (result.success) {
      return result
    }
    return {
      success: false,
      error: "Workspace was initialized but could not be detected.",
      category: "unknown",
    }
  } catch (error) {
    // Ensure we always get a string, never [object Object]
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error)
    const execError = error as { stderr?: string; code?: number | string }
    const stderr = typeof execError.stderr === "string" ? execError.stderr : undefined
    const exitCode = typeof execError.code === "number" ? execError.code : undefined

    const stderrDetail = stderr ? ` | stderr: ${stderr}` : ""
    const exitDetail = exitCode !== undefined ? ` | exit=${exitCode}` : ""
    console.error(
      `[workspace-init] bd init failed: ${msg}${stderrDetail}${exitDetail} | path=${resolvedDir}`,
    )

    const ph = getPostHogNode()
    if (ph) {
      ph.capture({
        distinctId: "server",
        event: "workspace_init_failed",
        properties: {
          error_message: msg,
          workspace_path: resolvedDir,
          platform: process.platform,
          bd_exit_code: exitCode,
        },
      })
      ph.flush()
    }

    const classified = classifyInitError(msg, stderr)
    return { success: false, ...classified }
  }
}

// Remove a workspace from the registry (does NOT delete .beads/ data)
// Accepts databasePath for backwards compatibility; resolves to UUID internally.
export async function removeWorkspace(
  databasePath: string,
): Promise<{ success: true; credentialKey?: string } | { success: false; error: string }> {
  const registry = await readRegistry()
  const entry = findWorkspaceByDbPath(registry, databasePath)
  if (!entry) {
    return { success: false, error: "Workspace not found in registry." }
  }
  const credentialKey = entry.credentialKey
  const removed = await workspaceTransition.runWorkspaceTransition(
    entry.id,
    () => removeWorkspaceFromRegistry(entry.id),
    { remove: true },
  )
  if (!removed) {
    return { success: false, error: "Workspace not found in registry." }
  }
  return { success: true, credentialKey }
}

// Discover beads databases on a Dolt server
export async function discoverServerDatabases(
  host: string,
  port: number,
  user?: string,
  password?: string,
  tls?: boolean,
): Promise<{ success: true; databases: ServerDatabase[] } | { success: false; error: string }> {
  try {
    const databases = await bdDiscoverServerDatabases(host, port, user, password, tls)
    if (databases.length === 0) {
      return {
        success: true,
        databases: [],
      }
    }
    return { success: true, databases }
  } catch {
    return {
      success: false,
      error:
        "Could not connect to the server. Check the host and port and verify the Dolt server is running.",
    }
  }
}

// Add a workspace from a Dolt server database.
// Stores ServerConnection in the registry; bd uses env vars for connection.
// No runtime directory creation needed.
export async function addServerWorkspace(
  host: string,
  port: number,
  databaseName: string,
  user: string = "root",
  password?: string,
  tls: boolean = false,
): Promise<
  | { success: true; workspace: WorkspaceCard; credentialKey: string }
  | { success: false; error: string }
> {
  const server: ServerConnection = { host, port, database: databaseName, user, tls }

  // Store password in process memory keyed by server identity
  if (password) {
    const serverKey = `${host}:${port}/${databaseName}`
    bdSetWorkspacePassword(serverKey, password)
  }

  // Derive display name from database name (strip beads_ prefix if present)
  const name = databaseName.startsWith("beads_")
    ? databaseName.slice("beads_".length)
    : databaseName

  // Write to registry (deduplicates by server identity: host+port+database)
  const workspaceId = await addServerWorkspaceEntry(name, server)

  const credentialKey = `${host}:${port}/${databaseName}/${user}`
  console.log(
    `[workspace-server] registered server workspace for ${databaseName} (${host}:${port})`,
  )

  // Create a local .beads/ scaffold so bd CLI commands work against the remote
  // server. Without this, bd fails with "no beads database found" because it
  // requires a local .beads/ directory for workspace discovery and metadata.
  const registryDir = dirname(getBeadboxRegistryPath())
  const scaffoldDir = join(registryDir, "workspaces", workspaceId)
  let localBeadsPath: string | null = null
  try {
    await workspaceTransition.preflightBdBinary()
    await workspaceTransition.runWorkspaceTransition(workspaceId, async () => {
      await mkdir(scaffoldDir, { recursive: true })
      await initServerScaffold(scaffoldDir, { host, port, database: databaseName, user }, password)
      localBeadsPath = join(scaffoldDir, ".beads")
      await updateWorkspaceLocal(workspaceId, localBeadsPath)
    })
    console.log(`[workspace-server] created scaffold at ${scaffoldDir}`)
  } catch (err) {
    console.warn(
      `[workspace-server] scaffold creation failed for ${databaseName}: ${err instanceof Error ? err.message : err}`,
    )
    // Workspace still works via server:// URI, just without bd CLI support
  }

  return {
    success: true,
    credentialKey,
    workspace: {
      id: workspaceId,
      name,
      path: localBeadsPath ? scaffoldDir : null,
      databasePath: localBeadsPath ?? `server://${host}:${port}/${databaseName}`,
      mode: "server",
      serverHost: host,
      serverPort: port,
      serverDatabase: databaseName,
      serverUser: user,
      serverTls: tls,
    },
  }
}

// Store a password for a workspace in server-side process memory.
// Called from the client after re-auth to update the in-memory password map
// (passwords are not persisted to disk by bd; keychain is handled client-side).
export async function setServerPassword(passwordMapKey: string, password: string): Promise<void> {
  bdSetWorkspacePassword(passwordMapKey, password)
}

// Two-phase Dolt server discovery

interface ScanActionResult {
  success: boolean
  servers: ScanResult[]
  portCount: number
  error?: string
}

export async function scanForDoltServers(): Promise<ScanActionResult> {
  try {
    const ports: number[] = []

    const workspaces = await inlineGetRegisteredWorkspaces()
    for (const ws of workspaces) {
      // Server-only workspaces: use port from server connection, no port file
      if (ws.serverPort && (ws.serverOnly || (ws.registered && ws.mode === "server"))) {
        ports.push(ws.serverPort)
        continue
      }
      const beadsDir = inlineBeadsDirFromDatabasePath(ws.databasePath)
      const portFile = join(beadsDir, "dolt-server.port")
      try {
        const content = await readFile(portFile, "utf-8")
        const p = parseInt(content.trim(), 10)
        if (p > 0 && p <= 65535) ports.push(p)
      } catch {
        // No port file for this workspace
      }
    }

    const uniquePorts = [...new Set(ports)]
    const servers = await scanPorts(uniquePorts)
    return { success: true, servers, portCount: uniquePorts.length }
  } catch (err) {
    return { success: false, servers: [], portCount: 0, error: String(err) }
  }
}

// Set the active workspace in the beadbox registry (called from client on workspace switch)
// Accepts databasePath for backwards compatibility; resolves to UUID internally.
export async function setActiveWorkspaceAction(databasePath: string): Promise<void> {
  const registry = await readRegistry()
  const entry = findWorkspaceByDbPath(registry, databasePath)
  if (entry) {
    await registrySetActiveWorkspace(entry.id)
  }
}

// Rename a workspace and/or set its tab emoji. Both fields are optional;
// `icon: null` clears the emoji. The registry is the single source of truth
// for the display label, so the rail, the header and the /workspaces cards
// all pick the change up from the next workspace list read.
const MAX_WORKSPACE_NAME_LENGTH = 64
// Emoji can be several code points (ZWJ sequences, skin-tone modifiers,
// flags). 16 UTF-16 units fits every standard sequence with room to spare
// while keeping a pasted paragraph out of the registry.
const MAX_WORKSPACE_ICON_LENGTH = 16

// One emoji grapheme: an Extended_Pictographic base carrying its variation
// selector, skin-tone modifier or tag characters, optionally ZWJ-joined to
// more of the same ("👩‍💻"), a two-character regional-indicator flag, or a
// keycap ("1️⃣"). Keycaps need their own alternative: their base is an ASCII
// digit, "#" or "*", which is not Extended_Pictographic, so the first branch
// rejects them even though the OS emoji picker offers them and the tab
// dialog's free-text field accepts whatever it produces.
// The icon is rendered as the workspace avatar, so a plain string like "abc"
// — which a length-only check accepts — must not reach it.
const EMOJI_PART = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*`
// U+20E3 is mandatory here, so a bare "1" stays rejected.
const KEYCAP = String.raw`[0-9#*]\uFE0F?\u20E3`
const SINGLE_EMOJI = new RegExp(
  `^(?:${EMOJI_PART}(?:\\u200D${EMOJI_PART})*|\\p{Regional_Indicator}{2}|${KEYCAP})$`,
  "u",
)

// Shared scan for both label fields. These characters must never reach the
// rail, the header or the dashboard cards: C0/DEL controls break the line,
// bidi overrides (U+202A-U+202E, U+2066-U+2069) render the rest of it
// reversed, and the zero-width family (U+200B-U+200F) makes two different
// labels render identically. U+200D is the one exception: it joins the parts
// of an emoji sequence.
function hasUnsafeLabelChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
    if (code >= 0x200b && code <= 0x200f && code !== 0x200d) return true
    if (code >= 0x202a && code <= 0x202e) return true
    if (code >= 0x2066 && code <= 0x2069) return true
  }
  return false
}

// resolveRegistryEntry hits the filesystem and dereferences entry.local (the
// v1 migration can produce an entry with local and server both null), and
// setWorkspaceLabel calls it after the registry write has already committed.
// A throw there has to come back as a failure result, not as a rejected rpc
// call the client cannot interpret.
async function resolveLabelledWorkspace(
  entry: RegistryEntry,
): Promise<{ success: true; workspace: Workspace } | { success: false; error: string }> {
  try {
    const resolved = await resolveRegistryEntry(entry)
    const available = resolved.serverOnly ? true : await databaseExists(resolved.databasePath)
    return { success: true, workspace: toWorkspace(resolved, available) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { success: false, error: `Could not read the workspace back: ${reason}` }
  }
}

type LabelPatch = { name?: string; icon?: string | null }
type LabelFailure = { success: false; error: string }

// `name` / `icon` cross the rpc boundary from the WebView, so their declared
// types are claims rather than guarantees. Each validator returns either the
// accepted value or the declared failure result — throwing would reject the
// call the client is awaiting.
function validateWorkspaceName(value: unknown): { name: string } | LabelFailure {
  if (typeof value !== "string") return { success: false, error: "Name must be text." }
  const name = value.replace(/\s+/g, " ").trim()
  if (name.length === 0) return { success: false, error: "Name cannot be empty." }
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    return {
      success: false,
      error: `Name must be ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer.`,
    }
  }
  if (hasUnsafeLabelChars(name)) {
    return { success: false, error: "Name contains characters that cannot be displayed." }
  }
  return { name }
}

function validateWorkspaceIcon(value: unknown): { icon: string | null } | LabelFailure {
  const rejected: LabelFailure = { success: false, error: "Icon must be a single emoji." }
  if (value === null) return { icon: null }
  if (typeof value !== "string") return rejected
  const icon = value.trim()
  if (icon.length === 0) return { icon: null }
  // Cheap pre-check before the regex: no standard sequence is this long.
  if (icon.length > MAX_WORKSPACE_ICON_LENGTH) return rejected
  if (hasUnsafeLabelChars(icon) || !SINGLE_EMOJI.test(icon)) return rejected
  return { icon }
}

function buildLabelPatch(label: LabelPatch): LabelPatch | LabelFailure {
  const patch: LabelPatch = {}
  if (label.name !== undefined) {
    const validated = validateWorkspaceName(label.name)
    if ("success" in validated) return validated
    patch.name = validated.name
  }
  if (label.icon !== undefined) {
    const validated = validateWorkspaceIcon(label.icon)
    if ("success" in validated) return validated
    patch.icon = validated.icon
  }
  return patch
}

export async function setWorkspaceLabel(
  workspaceId: string,
  label: LabelPatch,
): Promise<{ success: true; workspace: Workspace } | LabelFailure> {
  if (typeof label !== "object" || label === null) {
    return { success: false, error: "Invalid label." }
  }

  const patch = buildLabelPatch(label)
  if ("success" in patch) return patch

  if (patch.name === undefined && patch.icon === undefined) {
    // Nothing is being changed: report the current state without writing.
    const current = findWorkspace(await readRegistry(), workspaceId)
    if (!current) return { success: false, error: "Workspace not found." }
    return resolveLabelledWorkspace(current)
  }

  const entry = await updateWorkspaceLabel(workspaceId, patch)
  if (!entry) return { success: false, error: "Workspace not found." }
  return resolveLabelledWorkspace(entry)
}

// ---------------------------------------------------------------------------
// Server discovery overlap detection
// ---------------------------------------------------------------------------

export interface LocalOverlap {
  workspaceId: string
  localPath: string // display path (project dir, not .beads/)
}

// Check which discovered server databases already match a registered local workspace.
// Reads metadata.json of each local workspace to get its dolt server connection info,
// then compares against the discovered host+port+databaseName.
export async function getLocalWorkspaceOverlaps(
  host: string,
  port: number,
  databaseNames: string[],
): Promise<Record<string, LocalOverlap>> {
  const overlaps: Record<string, LocalOverlap> = {}
  if (databaseNames.length === 0) return overlaps

  const registry = await readRegistry()
  const localEntries = registry.workspaces.filter((w) => w.local !== null)

  for (const entry of localEntries) {
    const beadsDir = inlineBeadsDirFromDatabasePath(entry.local!.path)
    const modeInfo = await inlineReadWorkspaceMode(beadsDir)

    if (modeInfo.mode !== "server") continue

    // Normalize hosts: treat localhost variants as equivalent
    const metaHost = modeInfo.serverHost ?? "127.0.0.1"
    const normalizedMetaHost =
      metaHost === "localhost" || metaHost === "::1" ? "127.0.0.1" : metaHost
    const normalizedHost = host === "localhost" || host === "::1" ? "127.0.0.1" : host

    if (
      normalizedMetaHost === normalizedHost &&
      modeInfo.serverPort === port &&
      modeInfo.serverDatabase &&
      databaseNames.includes(modeInfo.serverDatabase)
    ) {
      const projectDir = projectDirFromDatabasePath(entry.local!.path)
      overlaps[modeInfo.serverDatabase] = {
        workspaceId: entry.id,
        localPath: projectDir,
      }
    }
  }

  return overlaps
}

// Replace a local workspace with a server-only workspace.
// Used when user discovers their local workspace on a Dolt server and wants to
// switch to server-based access.
export async function replaceLocalWithServer(
  localWorkspaceId: string,
  host: string,
  port: number,
  databaseName: string,
  user: string = "root",
  tls: boolean = false,
  password?: string,
): Promise<
  | { success: true; workspace: WorkspaceCard; credentialKey: string }
  | { success: false; error: string }
> {
  const server: ServerConnection = { host, port, database: databaseName, user, tls }

  if (password) {
    const serverKey = `${host}:${port}/${databaseName}`
    bdSetWorkspacePassword(serverKey, password)
  }

  const name = databaseName.startsWith("beads_")
    ? databaseName.slice("beads_".length)
    : databaseName
  const newId = await workspaceTransition.runWorkspaceTransition(
    localWorkspaceId,
    () => registryReplaceWorkspace(localWorkspaceId, name, server),
    { remove: true },
  )

  if (!newId) {
    return { success: false, error: "Local workspace not found in registry." }
  }

  const credentialKey = `${host}:${port}/${databaseName}/${user}`
  return {
    success: true,
    credentialKey,
    workspace: {
      id: newId,
      name,
      path: null,
      databasePath: `server://${host}:${port}/${databaseName}`,
      mode: "server",
      serverHost: host,
      serverPort: port,
      serverDatabase: databaseName,
      serverUser: user,
      serverTls: tls,
    },
  }
}

// Update an existing server workspace's connection details.
// Validates the connection before saving. Returns updated workspace card on success.
async function writeAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`
  try {
    const mode = await stat(path)
      .then((file) => file.mode & 0o777)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0o600
        throw error
      })
    await writeFile(tempPath, content, { flag: "wx", mode })
    await rename(tempPath, path)
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

async function syncExternalPortFile(beadsDir: string, port: number): Promise<void> {
  const portPath = join(beadsDir, "dolt-server.port")
  await writeAtomic(portPath, `${port}\n`)
}

async function saveServerConnection(
  workspaceId: string,
  entry: RegistryEntry,
  newServer: ServerConnection,
  password: string,
): Promise<{ success: true } | { success: false; error: string }> {
  if (password) {
    const serverKey = `${newServer.host}:${newServer.port}/${newServer.database}`
    bdSetWorkspacePassword(serverKey, password)
  }
  const externalScaffold =
    getServerOwnership(entry) === "external" && entry.local ? entry.local.path : null
  let restoreScaffold: (() => Promise<void>) | null = null
  try {
    if (externalScaffold) {
      const metaPath = join(externalScaffold, "metadata.json")
      const configPath = join(externalScaffold, "config.yaml")
      const [originalMeta, originalConfig] = await Promise.all([
        readFile(metaPath, "utf-8"),
        readFile(configPath, "utf-8"),
      ])
      const originalPort = await readFile(
        join(externalScaffold, "dolt-server.port"),
        "utf-8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      })
      restoreScaffold = async () => {
        await writeAtomic(metaPath, originalMeta)
        await writeAtomic(configPath, originalConfig)
        const portPath = join(externalScaffold, "dolt-server.port")
        if (originalPort === null) await rm(portPath, { force: true })
        else await writeAtomic(portPath, originalPort)
      }
      await ensureExternalScaffold(externalScaffold, newServer)
      await syncExternalPortFile(externalScaffold, newServer.port)
    }
    await updateWorkspaceServer(workspaceId, newServer)
  } catch (error) {
    if (restoreScaffold) await restoreScaffold().catch(() => {})
    return { success: false, error: `Could not save server connection: ${String(error)}` }
  }

  if (entry.local) {
    // Evict old endpoint connections before resuming paused subscriptions.
    await drainPool(entry.local.path).catch((error) =>
      console.warn(`[workspaces] pool drain failed: ${error}`),
    )
  }
  return { success: true }
}

export async function updateServerConnection(
  workspaceId: string,
  host: string,
  port: number,
  user: string,
  password: string,
  tls: boolean,
): Promise<{ success: true; workspace: WorkspaceCard } | { success: false; error: string }> {
  const registry = await readRegistry()
  const entry = registry.workspaces.find((w) => w.id === workspaceId)
  if (!entry) {
    return { success: false, error: "Workspace not found in registry." }
  }
  if (!entry.server) {
    return { success: false, error: "Workspace is not a server workspace." }
  }

  const database = entry.server.database
  const newServer: ServerConnection = { host, port, database, user, tls }

  // Validate the connection before saving
  try {
    const databases = await bdDiscoverServerDatabases(host, port, user, password || undefined, tls)
    const found = databases.some((db) => db.databaseName === database)
    if (!found) {
      return {
        success: false,
        error: `Connected to server but database "${database}" was not found.`,
      }
    }
  } catch {
    return {
      success: false,
      error: "Could not connect to the server. Check the host, port, user, and password.",
    }
  }

  const connectionUpdate = await workspaceTransition.runWorkspaceTransition(workspaceId, () =>
    saveServerConnection(workspaceId, entry, newServer, password),
  )
  if (!connectionUpdate.success) return connectionUpdate

  // Express the updated entry in the shape resolveRegistryEntry would produce
  // so the reply goes through the one mapper. The hand-built card here used to
  // omit `icon`, which cleared the workspace emoji in client state every time
  // a connection was reconfigured.
  const resolved: InlineWorkspace = {
    id: workspaceId,
    name: entry.name,
    icon: entry.icon,
    path: entry.local?.path ?? null,
    databasePath: entry.local?.path ?? `server://${host}:${port}/${database}`,
    registered: true,
    serverOnly: entry.local === null,
    mode: "server",
    serverHost: host,
    serverPort: port,
    serverDatabase: database,
    serverUser: user,
    serverTls: tls,
  }
  const available = resolved.serverOnly ? true : await databaseExists(resolved.databasePath)
  return {
    success: true,
    workspace: {
      ...toWorkspace(resolved, available),
      path: resolved.path,
      databasePath: resolved.databasePath,
    },
  }
}
