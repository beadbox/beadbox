import { createHash } from "crypto"
import { existsSync, readFileSync } from "fs"
import { readFile } from "fs/promises"
import mysql from "mysql2/promise"
import { basename, dirname, join } from "path"
import { BdError, classifyBdError } from "./bd-error"
import { bdServeReadsEnabled } from "./app-config"
import { buildServerEnv, getWorkspacePassword } from "./credential-provider"
import { ensureExternalScaffold } from "./external-scaffold"
import { __resetBdPathCache, COMMON_BD_PATHS, resolveBdPath as getBdPath } from "./bd-paths"
import { getWorkspaceWriteMarkerPaths } from "./dolt-write-marker"
import {
  assertNotFlagLike,
  assertNumericId,
  assertSafeBeadId,
  assertSafeBeadIds,
  buildCommentArgs,
  buildUpdateArgs,
  flagArg,
} from "./bd-argv"
import { execFileAsync } from "./exec"
import { recordFlockContention } from "./flock-contention-tracker"
import { SERVER_POLL_SQL } from "./server-poll-sql"
import { ServeHttpError, type IssueDetails } from "./serve-http"
import { serveManager } from "./serve-manager"
import { resolveWorkspaceTarget, type WorkspaceTarget } from "./workspace-resolver"
import { workspaceTransition } from "./workspace-transition"
import { compareVersions } from "./version-requirements"
import type {
  BeadPriority,
  BeadStatus,
  CookedFormula,
  FormulaDetail,
  FormulaSummary,
  MoleculeCard,
  MoleculeEdge,
  MoleculeGraph,
  MoleculeNode,
  MolProgress,
  MolProgressRaw,
  ServerDatabase,
} from "./types"
import {
  findExternalWorkspaceByDbPath,
  parseServerUri,
  type ServerConnection,
} from "./workspace-registry"

// Reset helpers are exported for test teardown only.
// eslint-disable-next-line @typescript-eslint/no-empty-function
export function __resetBdVersionCache() {
  /* no-op: version cache removed */
}

// Per-database mutex: serialize bd CLI calls targeting the same db path to
// ensure predictable request ordering. bd 1.0.0 uses flock internally, so
// concurrent access no longer causes crashes, but sequential ordering avoids
// interleaving issues in multi-action server actions.
const dbLocks = new Map<string, Promise<unknown>>()

// Derive the serialization key for a BdOptions: db path, server identity, or default.
function lockKeyFromOptions(options: BdOptions): string {
  if (options.server)
    return `${options.server.host}:${options.server.port}/${options.server.database}`
  if (options.db) return options.db
  return "__default__"
}

function withDbLock<T>(dbPath: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = dbPath ?? "__default__"
  const prev = dbLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn) // run fn regardless of previous result
  dbLocks.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  ) // swallow to keep chain alive
  return next
}

// Reset lock map (for testing only)
export function __resetDbLocks() {
  dbLocks.clear()
}

// Known informational warnings that bd writes to stderr on successful commands.
// These are not errors: permission hints, deprecation notices, config suggestions.
// stripBdWarnings() removes them so they don't pollute error messages or logs.
const BD_WARNING_PATTERNS = [
  /^warning:.*beads\.role not configured.*$/m,
  /^\s*Fix:.*git config beads\.role.*$/m,
  /^\s*Or:\s*git config beads\.role.*$/m,
  /^warning:.*permissions\s+0750.*recommended.*0700.*$/m,
  /^warning:.*dolt_server_port\s+deprecated.*$/m,
  /^warning:.*$/im, // catch-all for any "warning:" prefixed line
]

// Strip known bd warning lines from stderr, returning only actionable content.
// Exported for testing.
export function stripBdWarnings(stderr: string): string {
  let cleaned = stderr
  for (const pattern of BD_WARNING_PATTERNS) {
    cleaned = cleaned.replace(pattern, "")
  }
  return cleaned.replace(/\n{3,}/g, "\n\n").trim()
}

// Flock contention retry for embedded mode.
// bd 1.0+ uses flock for concurrency; concurrent processes get a lock error.
const FLOCK_ERROR_RE = /another process holds the exclusive lock|flock.*locked/i
const FLOCK_RETRIES = 7
const FLOCK_BASE_DELAY_MS = 200 // 200, 400, 800, 1600, 3000, 3000, 3000ms
const FLOCK_MAX_DELAY_MS = 3000

/** Test-only override for flock base delay. */
export const _flockTestOverrides = { baseDelayMs: null as number | null }

function isFlockError(error: unknown): boolean {
  const e = error as { stderr?: string; message?: string }
  const text = `${e.stderr ?? ""} ${e.message ?? ""}`
  return FLOCK_ERROR_RE.test(text)
}

async function retryOnFlock<T>(fn: () => Promise<T>, dbPath: string | undefined): Promise<T> {
  if (!dbPath || !isEmbeddedMode(dbPath)) return fn()
  const baseDelay = _flockTestOverrides.baseDelayMs ?? FLOCK_BASE_DELAY_MS
  let lastError: unknown
  for (let attempt = 0; attempt <= FLOCK_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isFlockError(err) || attempt === FLOCK_RETRIES) throw err
      lastError = err
      const delay = Math.min(baseDelay * 2 ** attempt, FLOCK_MAX_DELAY_MS)
      console.warn(
        `[bd] flock contention (attempt ${attempt + 1}/${FLOCK_RETRIES}), retrying in ${delay}ms`,
      )
      recordFlockContention(dbPath)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

// Keep the public bd.ts exports for existing handlers and tests.
export {
  setWorkspacePassword,
  clearWorkspacePassword,
  getWorkspacePassword,
} from "./credential-provider"

// Re-export for existing consumers
export { __resetBdPathCache, COMMON_BD_PATHS, getBdPath }

export interface BdOptions {
  db?: string // Path to database file
  workspaceId?: string // Stable registry identity for new RPC callers
  server?: import("./workspace-registry").ServerConnection // For server-only workspaces (env var mode)
  cwd?: string // Working directory
  env?: Record<string, string> // Extra environment variables
  parallel?: boolean // Bypass per-db lock (safe for read-only calls in server mode)
  includeSystem?: boolean // Include gates, infrastructure, and template issues in lists
}

type ScopedOptions = BdOptions & { __scoped?: true }
const verifiedCliTargets = new Set<string>()
const detailReads = new Map<string, Promise<IssueDetails>>()

async function targetFor(options: BdOptions): Promise<WorkspaceTarget | null> {
  const key = options.workspaceId ?? options.db
  if (!key) return null
  try {
    return await resolveWorkspaceTarget(key)
  } catch (error) {
    if (
      !options.workspaceId &&
      options.db &&
      !options.db.startsWith("server://") &&
      error instanceof Error &&
      error.message.startsWith("Workspace not found:")
    )
      return null
    throw error
  }
}

async function assertCurrentTarget(target: WorkspaceTarget): Promise<void> {
  const current = await resolveWorkspaceTarget(target.id)
  if (current.generation !== target.generation) {
    throw new Error(`Workspace target changed during operation: ${target.id}`)
  }
}

async function withCliScope<T>(
  options: ScopedOptions,
  run: (scoped: BdOptions) => Promise<T>,
): Promise<T> {
  if (options.__scoped) return run(options)
  const target = await targetFor(options)
  if (!target) return run(options)
  return workspaceTransition.withOperation(target.id, async () => {
    await assertCurrentTarget(target)
    const scoped: BdOptions = {
      ...options,
      db: target.cliDbPath,
      server: target.localBeadsDir ? undefined : (target.serverConnection ?? undefined),
    }
    const result = await run(scoped)
    verifiedCliTargets.add(`${target.id}:${target.generation}`)
    return result
  })
}

function mayFallbackToCli(error: unknown, target: WorkspaceTarget): boolean {
  if (!(error instanceof ServeHttpError)) return false
  if (error.kind !== "startup" && error.kind !== "transport" && !(error.status === 503))
    return false
  return (
    verifiedCliTargets.has(`${target.id}:${target.generation}`) &&
    !!target.localBeadsDir &&
    existsSync(join(target.localBeadsDir, "metadata.json"))
  )
}

async function readViaServe<T>(
  options: BdOptions,
  capability: string,
  http: (target: WorkspaceTarget) => Promise<T>,
  cli: (options: BdOptions) => Promise<T>,
  retryTransient = true,
): Promise<T> {
  const target = await targetFor(options)
  if (!target || target.mode !== "server" || !(await bdServeReadsEnabled())) return cli(options)
  return workspaceTransition.withOperation(target.id, async () => {
    await assertCurrentTarget(target)
    const scoped: ScopedOptions = { ...options, db: target.cliDbPath, __scoped: true }
    if (compareVersions(await workspaceTransition.bdVersion(), "1.3.0") < 0) return cli(scoped)
    // A cold remote serve takes several seconds to complete DB readiness.
    // The first tree can use the already validated CLI route while serve warms
    // for subsequent reads; this preserves the single flat-list request.
    if (capability === "issues.list" && !serveManager.hasReadySession(target)) {
      serveManager.prewarm(target)
      console.debug(`[bd-serve] CLI read workspace=${target.id} capability=issues.list reason=cold_start`)
      return cli(scoped)
    }
    const started = performance.now()
    let retriesUsed = 0
    try {
      let retriesLeft = retryTransient ? 1 : 0
      const withTransientRetry = async <R>(operation: () => Promise<R>): Promise<R> => {
        try {
          return await operation()
        } catch (error) {
          const transient =
            error instanceof ServeHttpError &&
            (error.status === 503 || error.kind === "transport")
          const delay = error instanceof ServeHttpError && error.status === 503
            ? (error.retryAfter ?? 0) * 1_000
            : 200
          // A server-specified delay beyond the UI budget means no HTTP retry.
          if (!transient || retriesLeft === 0 || delay > 1_500) throw error
          retriesLeft -= 1
          retriesUsed += 1
          await new Promise((resolve) => setTimeout(resolve, Math.max(delay, 100)))
          return operation()
        }
      }
      const session = await withTransientRetry(() => serveManager.getSession(target))
      if (!session.hasCapability(capability)) {
        console.debug(`[bd-serve] CLI fallback workspace=${target.id} capability=${capability} reason=unsupported`)
        return cli(scoped)
      }
      const result = await withTransientRetry(() => http(target))
      console.debug(`[bd-serve] HTTP read workspace=${target.id} capability=${capability} elapsedMs=${Math.round(performance.now() - started)} retries=${retriesUsed}`)
      return result
    } catch (error) {
      if (!mayFallbackToCli(error, target)) throw error
      const reason = error instanceof ServeHttpError ? error.kind : "unknown"
      const status = error instanceof ServeHttpError ? (error.status ?? 0) : 0
      const retryAfter = error instanceof ServeHttpError && typeof error.retryAfter === "number"
        ? error.retryAfter : "none"
      const code = error instanceof ServeHttpError && error.code && /^[a-z0-9_]+$/.test(error.code)
        ? error.code : "none"
      const requestId = error instanceof ServeHttpError && error.requestId && /^[a-zA-Z0-9_-]{1,80}$/.test(error.requestId)
        ? error.requestId : "none"
      console.warn(`[bd-serve] CLI fallback workspace=${target.id} capability=${capability} reason=${reason} status=${status} code=${code} request_id=${requestId} retry_after=${retryAfter} elapsedMs=${Math.round(performance.now() - started)} retries=${retriesUsed}`)
      return cli(scoped)
    }
  })
}

function detailFromServe(target: WorkspaceTarget, id: string): Promise<IssueDetails> {
  const key = `${target.id}:${target.generation}:${id}`
  let pending = detailReads.get(key)
  if (!pending) {
    pending = serveManager.getSession(target).then((session) => session.getFullIssue(id))
    detailReads.set(key, pending)
    void pending.finally(() => detailReads.delete(key)).catch(() => {})
  }
  return pending
}

export interface BdBead {
  id: string
  title: string
  description?: string
  design?: string
  status: "open" | "in_progress" | "ready_for_qa" | "ready_to_ship" | "closed" | "tombstone"
  priority: number // 0-4 (0=critical, 4=low)
  issue_type: string
  assignee?: string
  owner?: string
  created_by?: string
  labels: string[]
  parent?: string
  created_at: string // ISO date string
  updated_at: string // ISO date string
  closed_at?: string // ISO date string
  deleted_at?: string
  acceptance_criteria?: string
  notes?: string
  external_ref?: string
  spec_id?: string
  due_at?: string
  defer_until?: string
  estimated_minutes?: number
  // Dependency fields (when this bead is a dependent of another)
  dependency_type?: "parent-child" | "blocks" | "related"
  // List output fields
  dependency_count?: number
  dependent_count?: number
  comment_count?: number
  // Epic/parent-specific (from show command)
  dependents?: BdBead[]
  total_children?: number
  closed_children?: number
  metadata?: Record<string, string>
  // NOT populated by showBead (bd show omits comment bodies by default,
  // and the `--include-comments` flag that streams them is version-gated
  // — see showBead). The detail panel fetches comment bodies separately
  // via getComments → `bd comments <id> --json` (stable across bd
  // versions). beadbox-a9l. This field stays on BdBead only for the rare
  // bd response that does carry it; production code does not rely on it.
  comments?: BdComment[]
}

export interface BdComment {
  id: string
  author: string
  text: string
  created_at: string // ISO date string
}

export interface BdEpicStatus {
  id: string
  title: string
  total_children: number
  closed_children: number
}

export interface BdWorkspace {
  workspace_path: string
  socket_path: string
  database_path: string
  pid: number
  version: string
  started_at: string
}

// Resolve the .beads directory from a db path. Works with any form:
// .beads -> .beads, .beads/beads.db -> .beads, .beads/dolt -> .beads
function resolveBeadsDir(dbPath: string): string {
  if (basename(dbPath) === ".beads") return dbPath
  const parent = dirname(dbPath)
  if (basename(parent) === ".beads") return parent
  return dirname(dbPath) // fallback
}

// Normalize .beads/ directory paths to a file path inside .beads/.
// bd expects --db to be a file path (e.g. .beads/beads.db or .beads/dolt),
// not the directory itself. When given the directory, filepath.Dir goes
// one level too high and metadata.json resolution fails.
// For embedded mode (bd >= 0.63), uses .beads/beads.db which bd accepts
// regardless of backend. For server mode, uses .beads/dolt.
function normalizeDbPath(dbPath: string): string {
  if (basename(dbPath) === ".beads") {
    const subpath = isEmbeddedMode(dbPath) ? "beads.db" : "dolt"
    return join(dbPath, subpath)
  }
  return dbPath
}

// Derive the project root from a db path that contains .beads/.
// Returns undefined if the path doesn't follow the .beads convention.
function projectRootFromDb(dbPath: string): string | undefined {
  const beadsDir = resolveBeadsDir(dbPath)
  if (basename(beadsDir) === ".beads") {
    return dirname(beadsDir)
  }
  return undefined
}

// Resolve the effective ServerConnection from options.
// Returns the explicit server field, or parses server:// from db, or null.
function resolveServer(options: BdOptions): ServerConnection | null {
  if (options.server) return options.server
  if (options.db?.startsWith("server://")) return parseServerUri(options.db)
  return null
}

// Build argument array for bd command (prevents command injection)
function buildArgs(args: string[], options: BdOptions, includeJson: boolean): string[] {
  const result: string[] = []
  const server = resolveServer(options)
  if (!server && options.db) {
    // Local workspace: --db points to the .beads directory.
    // Server-only workspaces use env vars only (injected by buildEnv).
    result.push("--db", normalizeDbPath(options.db))
  }
  result.push(...args)
  if (includeJson) {
    result.push("--json")
  }
  return result
}

// Read the Dolt server port from a workspace's dolt-server.port file.
// Returns undefined if the file doesn't exist or isn't a valid port.
function readDoltPort(dbPath: string): string | undefined {
  try {
    const beadsDir = resolveBeadsDir(dbPath)
    const port = readFileSync(join(beadsDir, "dolt-server.port"), "utf-8").trim()
    if (/^\d+$/.test(port)) return port
  } catch {
    /* file may not exist */
  }
  return undefined
}

// Detect embedded mode for a workspace. Used to guard bd sql calls
// which bd rejects with "bd sql is not yet supported in embedded mode".
//
// Detection order matches bd's own semantics (bb-yoof):
// 1. server:// URI -> server (explicit remote workspace)
// 2. metadata.json dolt_mode field -> trust it absolutely
// 3. dolt-server.port file -> server (legacy workspaces with no metadata)
// 4. Default -> embedded (no metadata, no port file)
//
// Critical: metadata.json takes priority over the port file. bd 1.0.0+
// auto-starts a Dolt server for ALL workspaces, including embedded ones,
// so the port file is no longer a reliable mode signal. bd's CLI checks
// metadata.json for the mode and rejects bd sql in embedded mode regardless
// of whether a server happens to be running. We must match that semantic
// or our guard misfires (820 events, 22 users on bb-yoof).
export function isEmbeddedMode(dbPath: string): boolean {
  if (dbPath.startsWith("server://")) return false
  const beadsDir = resolveBeadsDir(dbPath)

  // Priority 1: explicit dolt_mode in metadata.json. Trust the user's
  // configured intent over runtime artifacts.
  try {
    const meta = JSON.parse(readFileSync(join(beadsDir, "metadata.json"), "utf-8"))
    if (meta.dolt_mode === "embedded") return true
    if (meta.dolt_mode === "server") return false
    // dolt_mode field absent: fall through to port file detection
  } catch {
    // metadata.json missing or unparseable: fall through to port file detection
  }

  // Priority 2 (fallback): port file presence indicates a server was
  // configured. Only consulted when metadata doesn't specify dolt_mode.
  const portFile = join(beadsDir, "dolt-server.port")
  if (existsSync(portFile)) {
    try {
      const port = readFileSync(portFile, "utf-8").trim()
      if (/^\d+$/.test(port) && parseInt(port, 10) > 0) return false
    } catch {
      /* fall through */
    }
  }

  // Default: no metadata, no port file -> embedded (fresh workspace)
  return true
}

// Embedded-mode cache fingerprint. Hashes the workspace's canonical
// write-marker (Dolt manifest content per beadbox-v7l). Shared with
// change-detector.ts so cache invalidation and subscription emission
// agree on freshness.
//
// History of the inner `h` string format:
//   bb-3gnz.5  embedded:<bead-id>:<mtime>           (last-touched, retired bb-onv3.11)
//   bb-onv3.11 embedded:<journal-path>:<mtime>:<size>,...   (journal.idx, retired beadbox-v7l)
//   beadbox-v7l embedded:<manifest-path>:<sha256>,...        (current)
//
// See dolt-write-marker.ts for the empirical re-evaluation that drove
// each migration. Cache consumers compare the full JSON-stringified
// value; the `[{ h: ... }]` wrapper is opaque to them, so format
// changes are non-breaking.
//
// Exported for the bb-onv3.11 regression test seam (parallels
// change-detector.ts:getChangeFingerprint export).
export async function getEmbeddedFingerprint(dbPath: string): Promise<string> {
  try {
    const markerPaths = await getWorkspaceWriteMarkerPaths(dbPath)
    if (markerPaths.length === 0) {
      return JSON.stringify([{ h: `embedded:${Date.now()}` }])
    }
    const parts = await Promise.all(
      markerPaths.map(async (path) => {
        const data = await readFile(path).catch(() => null)
        if (!data) return null
        const hash = createHash("sha256").update(data).digest("hex").slice(0, 16)
        return `${path}:${hash}`
      }),
    )
    const combined = parts.filter((p): p is string => p !== null).join(",")
    if (combined === "") {
      return JSON.stringify([{ h: `embedded:${Date.now()}` }])
    }
    return JSON.stringify([{ h: `embedded:${combined}` }])
  } catch {
    return JSON.stringify([{ h: `embedded:${Date.now()}` }])
  }
}

/**
 * Build BEADS_DOLT_SERVER_* environment variables from a server connection.
 * Shared helper used by buildEnv(), workspace-health, and the legacy ws transport.
 */
export { buildServerEnv } from "./credential-provider"

// Best-effort JSON read. Returns parsed contents or null if the file is
// missing / unreadable / not JSON. bb-fe03.4: helper extracted so callers
// can stay try/catch-free; lizard's TS parser was summing CCN across
// neighbouring functions when try/catch blocks complicated boundaries.
export function tryReadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

// Read a workspace's metadata.json and return its dolt server identity
// triple, or null if metadata is missing/unparseable/incomplete.
export function readMetadataServerKey(dbPath: string): string | null {
  const meta = tryReadJson(join(resolveBeadsDir(dbPath), "metadata.json")) as {
    dolt_server_host?: string
    dolt_server_port?: number
    dolt_database?: string
  } | null
  if (!meta?.dolt_server_host || !meta?.dolt_server_port || !meta?.dolt_database) return null
  return `${meta.dolt_server_host}:${meta.dolt_server_port}/${meta.dolt_database}`
}

// Resolve the local-workspace password for a db path. Tries project root
// first (local workspaces), then falls back to server identity from
// metadata.json (scaffold workspaces backed by a remote server).
export function resolveLocalDbPassword(dbPath: string): string | undefined {
  const wsPath = projectRootFromDb(dbPath)
  const direct = wsPath ? getWorkspacePassword(wsPath) : undefined
  if (direct) return direct
  const serverKey = readMetadataServerKey(dbPath)
  if (!serverKey) return undefined
  const external = findExternalWorkspaceByDbPath(dbPath)
  return getWorkspacePassword(external?.server ? `${serverKey}/${external.server.user}` : serverKey)
}

// Resolve the BEADS_DOLT_SERVER_PORT injection. Returns undefined when an
// existing env or process.env override is already set, OR when the
// workspace's dolt-server.port file is unreadable. bb-fe03.4 extract.
export function resolveDoltPortOverride(
  dbPath: string,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (env?.BEADS_DOLT_SERVER_PORT || process.env.BEADS_DOLT_SERVER_PORT) return undefined
  return readDoltPort(dbPath) || undefined
}

// Build the subprocess environment, merging explicit env vars and injecting
// BEADS_DOLT_PASSWORD and BEADS_DOLT_SERVER_PORT when applicable.
//
// bb-fe03.4: lifted password / port resolution into resolveLocalDbPassword
// + resolveDoltPortOverride; this orchestrator now stays well under CCN 15.
export function buildEnv(options: BdOptions): NodeJS.ProcessEnv | undefined {
  let env: NodeJS.ProcessEnv | undefined = options.env
    ? { ...process.env, ...options.env }
    : undefined

  // Server connection (explicit or server:// URI): inject all connection env vars
  const server = resolveServer(options)
  if (server) {
    const serverKey = `${server.host}:${server.port}/${server.database}/${server.user}`
    const password = getWorkspacePassword(serverKey)
    return {
      ...(env ?? process.env),
      ...buildServerEnv(server, password),
      BEADS_DOLT_AUTO_START: "0",
      BEADS_DOLT_SERVER_MODE: "1",
    }
  }

  if (!options.db) return env

  const externalWorkspace = findExternalWorkspaceByDbPath(options.db)
  if (externalWorkspace?.server) {
    const configuredServer = externalWorkspace.server
    const serverKey = `${configuredServer.host}:${configuredServer.port}/${configuredServer.database}/${configuredServer.user}`
    const password = getWorkspacePassword(serverKey)
    return {
      ...(env ?? process.env),
      ...buildServerEnv(configuredServer, password),
      BEADS_DOLT_AUTO_START: "0",
      BEADS_DOLT_SERVER_MODE: "1",
    }
  }

  const password = resolveLocalDbPassword(options.db)
  if (password) {
    env = { ...(env ?? process.env), BEADS_DOLT_PASSWORD: password }
  }

  const portOverride = resolveDoltPortOverride(options.db, env)
  if (portOverride) {
    env = { ...(env ?? process.env), BEADS_DOLT_SERVER_PORT: portOverride }
  }

  return env
}

// Parse bd's stdout as JSON. Throws a helpful error on malformed output.
// Coerces a top-level `null` to `[]` because bd marshals nil Go slices to
// `null` (not `[]`) for list-returning commands when the slice is empty —
// e.g. `bd formula list --json` on a workspace with no formulas. Show-
// style commands surface "not found" via stderr/exit-code, never via a
// `null` body, so this coercion is safe across all callers (bb-el9n).
export function parseBdJson<T>(stdout: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    const preview = stdout.slice(0, 80).replace(/\n/g, " ")
    throw new Error(`bd returned unexpected output format (expected JSON): ${preview}`)
  }
  return (parsed === null ? [] : parsed) as T
}

// bb-fe03.4: extracted from bdExec / bdExecRaw run-closures so each
// closure stays well under CCN 15. The retry-on-ENOENT step is identical
// for both call sites (clear cache, re-resolve, re-exec); centralizing
// it removes ~10 LOC of duplication.
const EXEC_OPTS_BASE = { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 } as const

interface ExecError {
  stdout?: string
  stderr?: string
  message?: string
  code?: string
}

function isContextCanceled(err: ExecError): boolean {
  return Boolean(
    err.message?.includes("context canceled") || err.stderr?.includes("context canceled"),
  )
}

// Run a bd command, retrying ONCE if the bd path turned out stale
// (ENOENT). Throws on any other failure for callers to catch + classify.
async function execBdWithRetry(
  execArgs: string[],
  cwd: string | undefined,
  options: BdOptions,
): Promise<{ stdout: string; stderr: string }> {
  const opts = { cwd, env: buildEnv(options), ...EXEC_OPTS_BASE }
  try {
    return await execFileAsync(getBdPath(), execArgs, opts)
  } catch (err) {
    if ((err as ExecError).code !== "ENOENT") throw err
    console.warn("bd not found, re-resolving path...")
    __resetBdPathCache()
    return await execFileAsync(getBdPath(), execArgs, {
      cwd,
      env: buildEnv(options),
      ...EXEC_OPTS_BASE,
    })
  }
}

// Centralized error path for bdExec / bdExecRaw. Cleans stderr, optionally
// re-throws context-canceled raw, then hands off to classifyBdError. Returns
// nothing — always throws.
function handleBdError(
  error: unknown,
  subcmd: string,
  elapsed: number,
  opts: { rethrowOnContextCanceled: boolean; logExecArgs?: string[] },
): never {
  const execError = error as ExecError
  if (opts.rethrowOnContextCanceled && isContextCanceled(execError)) throw error
  const cleanedStderr = execError.stderr ? stripBdWarnings(execError.stderr) : null
  if (opts.logExecArgs) {
    console.error(`[bd] ${subcmd} failed in ${elapsed}ms: bd ${opts.logExecArgs.join(" ")}`)
    console.error("Error:", execError.message)
    if (cleanedStderr) console.error("Stderr:", cleanedStderr)
  } else {
    console.error(`[bd] ${subcmd} failed in ${elapsed}ms`)
  }
  if (cleanedStderr && execError.stderr !== cleanedStderr) {
    ;(error as { stderr?: string }).stderr = cleanedStderr
  }
  classifyBdError(error)
  // classifyBdError always throws; this is unreachable but TS needs it.
  throw error
}

// Execute a bd command and return parsed JSON (serialized per db path).
async function bdExec<T>(args: string[], options: BdOptions = {}): Promise<T> {
  return withCliScope(options, async (scoped) => {
    const run = async () => {
      const execArgs = buildArgs(args, scoped, true)
      const cwd = scoped.cwd ?? (scoped.db ? projectRootFromDb(scoped.db) : undefined)
      const subcmd = args[0] ?? "unknown"
      const t0 = performance.now()
      try {
        const { stdout, stderr } = await execBdWithRetry(execArgs, cwd, scoped)
        const elapsed = Math.round(performance.now() - t0)
        console.log(`[bd] ${subcmd} completed in ${elapsed}ms`)
        if (stderr) {
          const actionable = stripBdWarnings(stderr)
          if (actionable) console.error("bd stderr:", actionable)
        }
        const parsed = parseBdJson<T>(stdout)
        return parsed
      } catch (error) {
        const elapsed = Math.round(performance.now() - t0)
        handleBdError(error, subcmd, elapsed, {
          rethrowOnContextCanceled: true,
          logExecArgs: execArgs,
        })
      }
    }
    const withFlock = () => retryOnFlock(run, scoped.db)
    return scoped.parallel ? withFlock() : withDbLock(lockKeyFromOptions(scoped), withFlock)
  })
}

// Execute a bd command that doesn't return JSON (serialized per db path).
async function bdExecRaw(args: string[], options: BdOptions = {}): Promise<string> {
  return withCliScope(options, async (scoped) => {
    const run = async () => {
      const execArgs = buildArgs(args, scoped, false)
      const cwd = scoped.cwd ?? (scoped.db ? projectRootFromDb(scoped.db) : undefined)
      const subcmd = args[0] ?? "unknown"
      const t0 = performance.now()
      try {
        const { stdout } = await execBdWithRetry(execArgs, cwd, scoped)
        const elapsed = Math.round(performance.now() - t0)
        console.log(`[bd] ${subcmd} completed in ${elapsed}ms`)
        return stdout.trim()
      } catch (error) {
        const elapsed = Math.round(performance.now() - t0)
        handleBdError(error, subcmd, elapsed, {
          rethrowOnContextCanceled: false,
        })
      }
    }
    const withFlock = () => retryOnFlock(run, scoped.db)
    return scoped.parallel ? withFlock() : withDbLock(lockKeyFromOptions(scoped), withFlock)
  })
}

// List all epics
export async function listEpics(options: BdOptions = {}): Promise<BdBead[]> {
  const args = ["list", "--type", "epic", "--status", "all", "--limit", "0"]
  args.push("--flat")
  return readViaServe(
    options,
    "issues.list",
    async (target) =>
      (await (
        await serveManager.getSession(target)
      ).listIssues({ type: "epic", all: true, limit: 0 })) as unknown as BdBead[],
    (scoped) => bdExec<BdBead[]>(args, scoped),
  )
}

// Get epic status counters (total_children, closed_children for each epic)
export async function getEpicStatuses(options: BdOptions = {}): Promise<BdEpicStatus[]> {
  return bdExec<BdEpicStatus[]>(["epic", "status"], options)
}

// Get a single bead/epic by ID (includes dependents for epics).
//
// beadbox-a9l: this does NOT include comment bodies. bd show's comment
// behaviour is version-skewed — the `--include-comments` flag that
// streams bodies inline only exists in newer bd (1.0.5+), and passing
// it to CI's older bd fails with a usage dump. The detail panel sources
// comments via the dedicated, version-stable `bd comments <id> --json`
// subcommand (getComments below), called in parallel from
// getBeadDetail. See __tests__/bd-getBeadDetail-comments.test.ts.
export async function showBead(id: string, options: BdOptions = {}): Promise<BdBead> {
  const safeId = assertSafeBeadId(id)
  return readViaServe(
    options,
    "issues.get",
    async (target) => (await detailFromServe(target, safeId)) as unknown as BdBead,
    async (scoped) => {
      const result = await bdExec<BdBead[]>(["show", safeId], scoped)
      return result[0]
    },
  )
}

// Get multiple beads by ID in a single call (includes dependents for epics)
export async function showBeads(ids: string[], options: BdOptions = {}): Promise<BdBead[]> {
  if (ids.length === 0) return []
  return bdExec<BdBead[]>(["show", ...assertSafeBeadIds(ids)], options)
}

// Get comments for a bead
export async function getComments(id: string, options: BdOptions = {}): Promise<BdComment[]> {
  const safeId = assertSafeBeadId(id)
  return readViaServe(
    options,
    "issues.get",
    async (target) =>
      ((await detailFromServe(target, safeId)).comments ?? []) as unknown as BdComment[],
    (scoped) => bdExec<BdComment[]>(["comments", safeId], scoped),
  )
}

export interface BdDetailRead {
  bead: BdBead
  comments: BdComment[]
  dependencies: BdDependency[]
  dependents: BdDependency[]
}

// The detail panel chooses one transport for the whole response. A 503 must
// never combine an HTTP issue with CLI comments or dependency lists.
export async function readBeadDetail(
  id: string,
  options: BdOptions = {},
): Promise<BdDetailRead> {
  const safeId = assertSafeBeadId(id)
  return readViaServe(
    options,
    "issues.get",
    async (target) => {
      const detail = await detailFromServe(target, safeId)
      return {
        bead: detail as unknown as BdBead,
        comments: (detail.comments ?? []) as unknown as BdComment[],
        dependencies: (detail.dependencies ?? []) as unknown as BdDependency[],
        dependents: (detail.dependents ?? []) as unknown as BdDependency[],
      }
    },
    async (scoped) => {
      const [shown, comments, dependencies, dependents] = await Promise.allSettled([
        bdExec<BdBead[]>(["show", safeId], scoped),
        bdExec<BdComment[]>(["comments", safeId], scoped),
        bdExec<BdDependency[]>(["dep", "list", safeId], scoped),
        bdExec<BdDependency[]>(["dep", "list", safeId, "--direction=up"], scoped),
      ])
      if (shown.status === "rejected") {
        if (
          shown.reason instanceof BdError &&
          shown.reason.message.includes(`Issue ${safeId} not found`)
        )
          throw new Error(`Issue not found: ${safeId}`)
        throw shown.reason
      }
      if (!shown.value[0]) throw new Error(`Issue not found: ${safeId}`)
      if (comments.status === "rejected") throw comments.reason
      if (dependencies.status === "rejected") throw dependencies.reason
      if (dependents.status === "rejected") throw dependents.reason
      return {
        bead: shown.value[0],
        comments: comments.value,
        dependencies: dependencies.value,
        dependents: dependents.value,
      }
    },
  )
}

// Add a comment to a bead
export async function addComment(id: string, text: string, options: BdOptions = {}): Promise<void> {
  await bdExecRaw(buildCommentArgs(id, text), options)
}

// Delete a comment by ID. Uses bd sql DELETE — embedded mode can't run
// bd sql, so surface a clear error instead of letting bd's
// "bd sql is not yet supported in embedded mode" propagate to the UI.
export async function deleteComment(
  commentId: string | number,
  options: BdOptions = {},
): Promise<void> {
  if (!options.db) {
    throw new Error("Database path required for deleteComment")
  }
  // Positive-integer-only: the DELETE below interpolates this into SQL, and
  // a numeric identifier removes the quoting question entirely.
  const id = assertNumericId(commentId)
  if (isEmbeddedMode(options.db)) {
    throw new Error(
      "Comment deletion requires server-mode workspace. Embedded-mode bd has no comment-delete CLI.",
    )
  }
  const sql = `DELETE FROM comments WHERE id = ${id}`
  await bdExecRaw(["sql", sql], options)
}

// Update bead status
export async function updateStatus(
  id: string,
  status: string,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--status", status), options)
}

// Get custom statuses from bd config
export async function getCustomStatuses(options: BdOptions = {}): Promise<string[]> {
  const parse = (value: string | null): string[] => {
    const trimmed = value?.trim() ?? ""
    if (!trimmed || trimmed.includes("(not set)")) return []
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean)
  }
  return readViaServe(
    options,
    "config.get",
    async (target) => parse(await (await serveManager.getSession(target)).getSetting("status.custom")),
    async (scoped) => parse(await bdExecRaw(["config", "get", "status.custom"], scoped)),
  )
}

// Replace the custom-status list in bd config. Empty list unsets the key.
// Ported from v0.24 lib/bd.ts (commit 1386b41 / bb-oqux) for bb-wxuw.
export async function setCustomStatuses(
  statuses: string[],
  options: BdOptions = {},
): Promise<void> {
  const cleaned = statuses
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => assertNotFlagLike(s, "custom status"))
  if (cleaned.length === 0) {
    await bdExecRaw(["config", "unset", "status.custom"], options)
    return
  }
  await bdExecRaw(["config", "set", "status.custom", cleaned.join(",")], options)
}

// Update bead priority (0=critical, 1=high, 2=medium, 3=low, 4=none)
export async function updatePriority(
  id: string,
  priority: number,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--priority", priority.toString()), options)
}

// Update bead assignee
export async function updateAssignee(
  id: string,
  assignee: string,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--assignee", assignee), options)
}

// Update bead spec_id
export async function updateSpecId(
  id: string,
  specId: string,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--spec-id", specId), options)
}

// Update bead title
export async function updateTitle(
  id: string,
  title: string,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--title", title), options)
}

// Update bead description
export async function updateDescription(
  id: string,
  description: string,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--description", description), options)
}

export async function updateTextField(
  id: string,
  field: "description" | "acceptanceCriteria" | "notes",
  value: string,
  options: BdOptions = {},
): Promise<void> {
  const flags = {
    description: "--description",
    acceptanceCriteria: "--acceptance",
    notes: "--notes",
  } as const
  await bdExecRaw(buildUpdateArgs(id, flags[field], value), options)
}

// Update bead type
export async function updateType(
  id: string,
  type: import("./types").BeadType,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--type", type), options)
}

// Close a bead
export async function closeBead(id: string, options: BdOptions = {}): Promise<void> {
  await bdExecRaw(["close", assertSafeBeadId(id)], options)
}

// Reopen a bead
export async function reopenBead(id: string, options: BdOptions = {}): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--status", "open"), options)
}

// Delete a bead
export async function deleteBead(id: string, options: BdOptions = {}): Promise<void> {
  await bdExecRaw(["delete", assertSafeBeadId(id), "--force"], options)
}

// List all beads (not just epics)
export async function listBeads(options: BdOptions = {}): Promise<BdBead[]> {
  const args = ["list", "--status", "all", "--limit", "0"]
  args.push("--flat")
  return readViaServe(
    options,
    "issues.list",
    async (target) =>
      (await (await serveManager.getSession(target)).listIssues({
        all: true,
        limit: 0,
        ...(options.includeSystem
          ? { include_gates: true, include_infra: true, include_templates: true }
          : {}),
      })) as unknown as BdBead[],
    async (scoped) => {
      if (!options.includeSystem) return bdExec<BdBead[]>(args, scoped)
      // Full view must not silently omit a category on older bd releases.
      const flags = ["--include-gates", "--include-infra", "--include-templates"]
      try {
        return await bdExec<BdBead[]>([...args, ...flags], scoped)
      } catch (error) {
        const message = `${(error as { stderr?: string }).stderr ?? ""} ${String(error)}`
        const unsupported = message.match(
          /unknown flag:\s*['"]?(--include-(?:gates|infra|templates))/i,
        )?.[1]
        if (unsupported) {
          throw new Error(
            `The installed bd does not support ${unsupported}; upgrade bd to use All issues view`,
            { cause: error },
          )
        }
        throw error
      }
    },
  )
}

interface BdTypesResult {
  core_types?: Array<string | { name?: string }>
  custom_types?: Array<string | { name?: string }>
}

export function parseAvailableTypes(value: BdTypesResult): string[] {
  const names = [...(value.core_types ?? []), ...(value.custom_types ?? [])]
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter((name): name is string => typeof name === "string" && name.length > 0)
  return [...new Set(names)]
}

export async function getAvailableTypes(options: BdOptions = {}): Promise<string[]> {
  const result = await bdExec<BdTypesResult>(["types"], options)
  return parseAvailableTypes(result)
}

// Map bd priority number to our priority type.
// bb-fe03.4: lookup table replaces switch — parser-friendly + CCN-light
// (lizard was summing this function's length with everything after it).
const PRIORITY_BY_NUMBER: Readonly<Record<number, BeadPriority>> = Object.freeze({
  0: "critical",
  1: "high",
  2: "medium",
  3: "low",
  4: "backlog",
})

export const mapPriority = (priority: number): BeadPriority => PRIORITY_BY_NUMBER[priority] ?? "low"

// Map our priority type to bd priority number.
const NUMBER_BY_PRIORITY: Readonly<Record<BeadPriority, number>> = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  backlog: 4,
})

export const unmapPriority = (priority: BeadPriority): number => NUMBER_BY_PRIORITY[priority]

// Update bead due date
export async function updateDue(id: string, due: string, options: BdOptions = {}): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--due", due), options)
}

// Update bead defer date
export async function updateDefer(
  id: string,
  defer: string,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--defer", defer), options)
}

// Update bead estimated minutes
export async function updateEstimate(
  id: string,
  est: number,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--estimate", est.toString()), options)
}

// Update bead design
export async function updateDesign(
  id: string,
  design: string,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(buildUpdateArgs(id, "--design", design), options)
}

// Update bead parent (move bead to a different epic)
export async function updateParent(
  id: string,
  parentId: string | null,
  options: BdOptions = {},
): Promise<void> {
  // Empty string removes the parent; a non-null parent is itself a bead ID.
  const args = buildUpdateArgs(id, "--parent", parentId ? assertSafeBeadId(parentId) : "")
  await bdExecRaw(args, options)
}

export function mapType(type?: string): import("./types").BeadType {
  if (!type?.trim()) throw new Error("bd returned an issue without issue_type")
  return type
}

// Dependency types returned by bd dep list
export interface BdDependency {
  id: string
  title: string
  status: string
  dependency_type: "blocks" | "parent-child" | "related"
}

// List dependencies for a bead (beads that this bead depends on)
export async function listDependencies(
  id: string,
  options: BdOptions = {},
): Promise<BdDependency[]> {
  return bdExec<BdDependency[]>(["dep", "list", id], options)
}

// List dependents for a bead (beads that depend on this bead)
export async function listDependents(id: string, options: BdOptions = {}): Promise<BdDependency[]> {
  return bdExec<BdDependency[]>(["dep", "list", id, "--direction=up"], options)
}

// Remove a dependency between two beads
export async function removeDependency(
  issueId: string,
  dependsOnId: string,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(["dep", "remove", issueId, dependsOnId], options)
}

// Add a label to a bead
export async function addLabel(id: string, label: string, options: BdOptions = {}): Promise<void> {
  await bdExecRaw(["update", id, "--add-label", label], options)
}

// Remove a label from a bead
export async function removeLabel(
  id: string,
  label: string,
  options: BdOptions = {},
): Promise<void> {
  await bdExecRaw(["update", id, "--remove-label", label], options)
}

// Convert a bd-style duration string ("2m", "1h", "30s") to an ISO date string.
// bb-fe03.4: exported so bd-pure unit tests can pin behaviour directly. The
// implementation is intentionally branch-light (one regex + one lookup) so
// lizard's TS parser sees a clean function boundary; the previous switch /
// nested-conditional form was tripping the parser into summing neighbouring
// functions' CCN under this one.
const DURATION_UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
})

export const durationToISODate = (duration: string): string => {
  const match = duration.match(/^(\d+)([smhd])$/)
  const ms = match ? parseInt(match[1], 10) * (DURATION_UNIT_MS[match[2]] ?? 60_000) : 0
  return new Date(Date.now() - ms).toISOString()
}

/** Synthesize ActivityEvent[] from bd list output (fallback when daemon unavailable) */
function synthesizeActivityFromList(issues: BdBead[]): import("./types").ActivityEvent[] {
  return issues.map((issue) => {
    const actor = issue.assignee || issue.created_by || issue.owner || ""
    // Clean actor name: strip email suffixes like @users.noreply.github.com
    const actorShort = actor.includes("@") ? actor.split("@")[0] : actor

    // Determine event type from issue state
    let type: "create" | "update" | "status" | "comment" | "delete" = "update"
    let symbol = "→"
    let newStatus: string | undefined
    if (issue.status === "closed" && issue.closed_at === issue.updated_at) {
      type = "status"
      symbol = "✓"
      newStatus = "closed"
    } else if (issue.created_at === issue.updated_at) {
      type = "create"
      symbol = "+"
    }

    const statusLabel = issue.status.replace(/_/g, " ")
    const actorSuffix = actorShort ? ` @${actorShort}` : ""
    const message = `${issue.id} → ${statusLabel} · ${issue.title}${actorSuffix}`

    return {
      timestamp: issue.updated_at,
      type,
      issue_id: issue.id,
      symbol,
      message,
      actor: actorShort || undefined,
      new_status: newStatus,
    }
  })
}

// List activity events
// Tries bd activity first, then falls back to synthesizing
// activity from recently-updated issues via bd list (works in direct mode).
export async function listActivity(
  options: BdOptions = {},
  limit: number = 100,
  since?: string,
): Promise<import("./types").ActivityEvent[]> {
  return withCliScope(options, async (scoped) => {
    const args: string[] = []
    const server = resolveServer(scoped)
    if (scoped.db && !server) {
      args.push("--db", normalizeDbPath(scoped.db))
    }
    args.push("activity", "--limit", limit.toString())
    if (since) {
      args.push(flagArg("--since", since))
    }
    args.push("--json")
    const cwd = scoped.cwd ?? (scoped.db && !server ? projectRootFromDb(scoped.db) : undefined)

    try {
      const result = await withDbLock(lockKeyFromOptions(scoped), async () => {
        try {
          const { stdout, stderr } = await execFileAsync(getBdPath(), args, {
            cwd,
            env: buildEnv(scoped),
            maxBuffer: 10 * 1024 * 1024,
          })

          if (stderr) {
            const actionable = stripBdWarnings(stderr)
            if (actionable) {
              console.error("bd activity stderr:", actionable)
            }
          }

          return parseBdJson<import("./types").ActivityEvent[]>(stdout)
        } catch (innerError: unknown) {
          const innerExecError = innerError as { code?: string }
          if (innerExecError.code === "ENOENT") {
            console.warn(`bd not found, re-resolving path...`)
            __resetBdPathCache()
            const retryPath = getBdPath()
            const { stdout: retryActivityStdout } = await execFileAsync(retryPath, args, {
              cwd,
              env: buildEnv(scoped),
              maxBuffer: 10 * 1024 * 1024,
            })
            return parseBdJson<import("./types").ActivityEvent[]>(retryActivityStdout)
          }
          // Strip warnings before classification
          const innerExec = innerError as { stderr?: string }
          if (innerExec.stderr) {
            const cleaned = stripBdWarnings(innerExec.stderr)
            if (cleaned !== innerExec.stderr) innerExec.stderr = cleaned
          }
          classifyBdError(innerError)
        }
      })
      return result
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string; code?: string }
      const stderr = execError.stderr || execError.message || ""
      const needsFallback = stderr.includes("requires daemon") || stderr.includes("unknown command")

      if (!needsFallback) {
        throw error
      }

      // Fallback: synthesize activity from recently-updated issues
      console.warn("bd activity unavailable, falling back to bd list")
      const listArgs: string[] = [
        "list",
        "--status",
        "all",
        "--sort",
        "updated",
        "--limit",
        limit.toString(),
      ]
      listArgs.push("--flat")
      if (since) {
        listArgs.push("--updated-after", durationToISODate(since))
      }
      const issues = await bdExec<BdBead[]>(listArgs, scoped)
      return synthesizeActivityFromList(issues)
    }
  })
}

// Get workspace status summary (open, in_progress counts, etc.)
export interface BdStatusSummary {
  total_issues: number
  open_issues: number
  in_progress_issues: number
  closed_issues: number
  blocked_issues: number
}

export async function getWorkspaceStatus(options: BdOptions = {}): Promise<BdStatusSummary> {
  const result = await bdExec<{ summary: BdStatusSummary }>(["status"], options)
  return result.summary
}

// Initialize a new workspace in a directory
export async function initWorkspace(path: string): Promise<string> {
  const execArgs = ["init"]
  try {
    const { stdout } = await execFileAsync(getBdPath(), execArgs, {
      cwd: path,
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (error: unknown) {
    const execError = error as { code?: string }
    if (execError.code === "ENOENT") {
      console.warn(`bd not found, re-resolving path...`)
      __resetBdPathCache()
      const retryPath = getBdPath()
      const { stdout } = await execFileAsync(retryPath, execArgs, {
        cwd: path,
        maxBuffer: 10 * 1024 * 1024,
      })
      return stdout.trim()
    }
    throw error
  }
}

// Initialize a local .beads/ scaffold for a remote server workspace.
// This lets all bd CLI commands work against the remote server by giving bd
// a local workspace directory with server connection metadata.
export async function initServerScaffold(
  scaffoldDir: string,
  server: { host: string; port: number; database: string; user: string },
  password?: string,
): Promise<void> {
  const args = [
    "init",
    flagArg("--prefix", server.database),
    "--server",
    "--external",
    flagArg("--server-host", server.host),
    flagArg("--server-port", server.port.toString()),
    flagArg("--server-user", server.user),
    "--non-interactive",
    "--role",
    "maintainer",
    "--skip-agents",
    "--skip-hooks",
  ]
  const env: NodeJS.ProcessEnv = { ...process.env, BEADS_DOLT_AUTO_START: "0" }
  if (password) env.BEADS_DOLT_PASSWORD = password

  await execFileAsync(getBdPath(), args, {
    cwd: scaffoldDir,
    env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  })
  await ensureExternalScaffold(join(scaffoldDir, ".beads"), server)
}

async function queryWorkspaceSql<T>(
  options: BdOptions,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const target = await targetFor(options)
  const dbPath = target?.cliDbPath ?? options.db
  if (!dbPath) throw new Error("Workspace database path is required")
  const query = async () => {
    if (target) await assertCurrentTarget(target)
    const { getPool } = await import("./dolt-pool")
    const pool = await getPool(dbPath, target?.id)
    const [rows] = await pool.query(sql, values)
    return rows as T[]
  }
  return target ? workspaceTransition.withOperation(target.id, query) : query()
}

// Get a data fingerprint for cache validation.
// Server-only: direct MySQL query. Embedded: last-touched file.
// Local server: direct SQL through the existing pool.
//
// bb-gp97 (port of bb-y14e / commit ea7a14a from origin/main): early-
// return "" when options.db is undefined. Without the guard, the
// `if (options.db && isEmbeddedMode(...))` checks short-circuit on the
// undefined db, fall through to bdExec(["sql", sql], {}) which runs the
// bd CLI without --db. bd then auto-discovers from CWD, and if CWD is
// itself an embedded workspace, fires "'bd sql' is not yet supported in
// embedded mode" in production (PostHog logged 14 events / 1 user from
// this on v0.24.1). Sentinel "" doesn't match any cached fingerprint,
// forcing the upstream caller to take the cold path.
export async function getDataFingerprint(options: BdOptions = {}): Promise<string> {
  const dbPath = options.db ?? (await targetFor(options))?.cliDbPath
  if (!dbPath) return ""
  if (isEmbeddedMode(dbPath)) {
    return await getEmbeddedFingerprint(dbPath)
  }
  const rows = await queryWorkspaceSql<Record<string, string>>(options, SERVER_POLL_SQL)
  return JSON.stringify(rows)
}

// Get IDs of beads whose updated_at is strictly after the given ISO timestamp.
// Server-only: direct MySQL. Embedded: returns empty (forces full rebuild).
//
// bb-gp97: extend the embedded-mode short-circuit to also fire when no
// db is provided — same defensive pattern as getDataFingerprint above
// and getAllBlocksDependencies below. Returns [] (forces full rebuild,
// matching the embedded-mode shape).
export async function getChangedBeadIds(since: string, options: BdOptions = {}): Promise<string[]> {
  const dbPath = options.db ?? (await targetFor(options))?.cliDbPath
  if (!dbPath) return []
  if (isEmbeddedMode(dbPath)) {
    return [] // force full rebuild; embedded mode can't do SQL queries
  }
  const rows = await queryWorkspaceSql<{ id: string }>(
    options,
    "SELECT id FROM issues WHERE updated_at > ?",
    [since],
  )
  return rows.map((r) => r.id)
}

// Get all "blocks" dependencies in one bulk query via bd sql
// Returns a map: beadId -> array of IDs that block it
// Embedded mode: returns empty map (bd sql unsupported)
export async function getAllBlocksDependencies(
  options: BdOptions = {},
): Promise<Map<string, string[]>> {
  const dbPath = options.db ?? (await targetFor(options))?.cliDbPath
  if (!dbPath) return new Map()
  if (isEmbeddedMode(dbPath)) return new Map()

  try {
    const sql = `SELECT issue_id, depends_on_issue_id AS depends_on_id FROM dependencies WHERE type = 'blocks'`
    const rows = await queryWorkspaceSql<{ issue_id: string; depends_on_id: string }>(options, sql)
    if (!rows || rows.length === 0) return new Map()

    const map = new Map<string, string[]>()
    for (const row of rows) {
      const existing = map.get(row.issue_id)
      if (existing) {
        existing.push(row.depends_on_id)
      } else {
        map.set(row.issue_id, [row.depends_on_id])
      }
    }
    return map
  } catch {
    return new Map()
  }
}

// Validate that a configured workspace directory points to a database with the beads schema.
// Runs a lightweight bd list with limit 1 to check if the issues table exists.
// Returns { valid: true } or { valid: false, error: string }.
// For server-only workspaces, pass server instead of workspaceDir.
export async function validateServerSchema(
  workspaceDir: string,
  password?: string,
  server?: import("./workspace-registry").ServerConnection,
): Promise<{ valid: true } | { valid: false; error: string }> {
  try {
    const listArgs = ["list", "--status", "all", "--limit", "1"]
    listArgs.push("--flat")

    const bdOptions: BdOptions = {}
    if (server) {
      bdOptions.server = server
      if (password) {
        bdOptions.env = { BEADS_DOLT_PASSWORD: password }
      }
    } else {
      bdOptions.db = normalizeDbPath(join(workspaceDir, ".beads"))
      bdOptions.cwd = workspaceDir
      if (password) {
        bdOptions.env = { BEADS_DOLT_PASSWORD: password }
      }
    }

    await bdExec(listArgs, bdOptions)
    return { valid: true }
  } catch (error: unknown) {
    const execError = error as { stderr?: string; message?: string }
    const errText = execError.stderr || execError.message || "Unknown error"

    if (
      errText.includes("table not found") ||
      (errText.includes("Table") && errText.includes("doesn't exist"))
    ) {
      return {
        valid: false,
        error:
          "This database does not contain the beads schema. It may be a non-beads Dolt database.",
      }
    }
    return { valid: false, error: `Schema validation failed: ${errText.split("\n")[0]}` }
  }
}

// Discover beads databases on a Dolt server via direct MySQL protocol connection.
// Uses mysql2 instead of bd because bd always runs schema init (CREATE TABLE)
// before any SQL query, which fails on read-only system databases.
// When validateSchema is true (default), filters to only databases that have the
// beads issues table, so non-beads databases never reach the UI.
export async function discoverServerDatabases(
  host: string,
  port: number,
  user?: string,
  password?: string,
  tls?: boolean,
  validateSchema: boolean = true,
): Promise<ServerDatabase[]> {
  const connection = await mysql.createConnection({
    host,
    port,
    user: user || "root",
    password: password || undefined,
    ssl: tls ? {} : undefined,
    connectTimeout: 5000,
  })

  try {
    const [rows] = await connection.query("SHOW DATABASES")
    const candidates: ServerDatabase[] = []

    const systemDatabases = new Set(["information_schema", "mysql"])
    for (const row of rows as Array<Record<string, string>>) {
      const dbName = row.Database || row.database || Object.values(row)[0]
      if (typeof dbName === "string" && !systemDatabases.has(dbName)) {
        candidates.push({
          databaseName: dbName,
          beadsPrefix: dbName.startsWith("beads_") ? dbName.slice("beads_".length) : dbName,
        })
      }
    }

    if (!validateSchema || candidates.length === 0) return candidates

    // Validate each candidate has the beads schema (issues table) in parallel
    const validated = await Promise.all(
      candidates.map(async (db) => {
        try {
          await connection.query(`SELECT 1 FROM \`${db.databaseName}\`.issues LIMIT 1`)
          return db
        } catch {
          return null
        }
      }),
    )

    return validated.filter((db): db is ServerDatabase => db !== null)
  } finally {
    await connection.end()
  }
}

// Raw dependency from bd mol show --json
interface BdMolDependency {
  issue_id: string
  depends_on_id: string
  type: "blocks" | "parent-child"
  created_at: string
  created_by: string
  metadata: string
}

// Get molecule structure as a graph (nodes + edges)
// Calls bd mol show <id> --json for the dependency graph,
// then enriches nodes with status/title/type via bd show.
export async function getMoleculeStructure(
  id: string,
  options: BdOptions = {},
): Promise<MoleculeGraph> {
  const raw = await bdExec<{ dependencies: BdMolDependency[] }>(["mol", "show", id], options)
  const deps = raw.dependencies || []

  // Collect unique node IDs
  const nodeIds = new Set<string>()
  for (const dep of deps) {
    nodeIds.add(dep.issue_id)
    nodeIds.add(dep.depends_on_id)
  }

  // Filter to "blocks" dependencies for DAG edges
  const edges: MoleculeEdge[] = deps
    .filter((d) => d.type === "blocks")
    .map((d) => ({ source: d.issue_id, target: d.depends_on_id }))

  // Fetch node metadata in bulk
  const nodeIdList = Array.from(nodeIds)
  const beads = nodeIdList.length > 0 ? await showBeads(nodeIdList, options) : []
  const beadMap = new Map(beads.map((b) => [b.id, b]))

  const nodes: MoleculeNode[] = nodeIdList.map((nid) => {
    const b = beadMap.get(nid)
    return {
      id: nid,
      title: b?.title ?? nid,
      status: (b?.status ?? "open") as BeadStatus,
      type: b ? mapType(b.issue_type) : "unknown",
      gateType: b?.issue_type === "gate" ? (b.metadata?.gate_type ?? "human") : undefined,
    }
  })

  return { nodes, edges, rootId: id }
}

// Formula commands

export async function listFormulas(options: BdOptions = {}): Promise<FormulaSummary[]> {
  return bdExec<FormulaSummary[]>(["formula", "list"], options)
}

export async function showFormula(name: string, options: BdOptions = {}): Promise<FormulaDetail> {
  return bdExec<FormulaDetail>(["formula", "show", name], options)
}

export async function cookFormula(
  name: string,
  vars?: Record<string, string>,
  options: BdOptions = {},
): Promise<CookedFormula> {
  const args = ["cook", name]
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      args.push("--var", `${k}=${v}`)
    }
  }
  return bdExec<CookedFormula>(args, options)
}

export async function pourMolecule(
  formula: string,
  vars: Record<string, string>,
  assignee?: string,
  options: BdOptions = {},
): Promise<void> {
  const args = ["mol", "pour", formula]
  for (const [k, v] of Object.entries(vars)) {
    args.push("--var", `${k}=${v}`)
  }
  if (assignee) args.push("--assignee", assignee)
  await bdExecRaw(args, options)
}

export async function getMoleculeProgress(
  id: string,
  options: BdOptions = {},
): Promise<MolProgress> {
  const raw = await bdExec<MolProgressRaw>(["mol", "progress", id], options)
  return {
    id: raw.molecule_id,
    name: raw.molecule_title,
    total: raw.total,
    completed: raw.completed,
    inProgress: raw.in_progress,
    percent: raw.percent,
    currentStepId: raw.current_step_id || undefined,
  }
}

// List molecules for a given formula by querying epics with bb-mol- prefix
export async function listMoleculesForFormula(
  formulaName: string,
  options: BdOptions = {},
): Promise<MoleculeCard[]> {
  const epics = await listEpics(options)
  return epics
    .filter((b) => b.id.startsWith("bb-mol-") && b.title.startsWith(formulaName))
    .map((b) => ({
      id: b.id,
      title: b.title,
      status: b.status,
      assignee: b.assignee,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    }))
}

// Raw mol show output structure
export interface MolShowRaw {
  root: { id: string; title: string; status: string; assignee?: string }
  issues: Array<{
    id: string
    title: string
    status: string
    issue_type: string
    assignee?: string
    updated_at: string
  }>
  dependencies: Array<{
    issue_id: string
    depends_on_id: string
    type: string
  }>
}

// Get full molecule structure for overlay mapping (issues + dependencies)
export async function getMoleculeStructureRaw(
  id: string,
  options: BdOptions = {},
): Promise<MolShowRaw> {
  return bdExec<MolShowRaw>(["mol", "show", id], options)
}
