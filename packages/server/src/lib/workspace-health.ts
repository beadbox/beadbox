// Source-local copy of lib/workspace-health.ts (P1.3 / bb-vy13.3).
// Rewrites: @/lib/* → ./* across the import block. Body unchanged.

import { readFileSync } from "fs"
import { mkdir } from "fs/promises"
import mysql from "mysql2/promise"
import { basename, dirname, join } from "path"
import { getWorkspacePassword, initServerScaffold, stripBdWarnings } from "./bd"
import { resolveBdPath } from "./bd-paths"
import { drainPool } from "./dolt-pool"
import { ensureExternalScaffold } from "./external-scaffold"
import { execFileAsync } from "./exec"
import type { HealthError } from "./startup-machine"
import { compareVersions, MIN_BD_VERSION } from "./version-requirements"
import { workspaceTransition } from "./workspace-transition"
import {
  getBeadboxRegistryPath,
  getServerOwnership,
  isBeadboxScaffold,
  type RegistryEntry,
  resolveBdDbPath,
  updateWorkspaceLocal,
} from "./workspace-registry"

const HEALTH_TIMEOUT_MS = 15_000

// Normalize a dbPath for bd dolt start.
// resolveBdDbPath() returns .beads/beads.db for local workspaces, but
// bd dolt start doesn't handle the .db suffix (unlike bd list which has
// legacy resolution). Normalize to .beads/dolt which bd dolt start expects.
function normalizeDbPathForDolt(dbPath: string): string {
  const base = basename(dbPath)
  const parent = dirname(dbPath)
  // .beads/beads.db or any file inside .beads/ -> .beads/dolt
  if (basename(parent) === ".beads" && base !== "dolt") {
    return join(parent, "dolt")
  }
  // .beads/ directory -> .beads/dolt
  if (base === ".beads") {
    return join(dbPath, "dolt")
  }
  return dbPath
}

/**
 * Resolve the authoritative Dolt port for a workspace.
 *
 * - Server-only workspaces (local === null): registry port is authoritative (user-configured).
 * - Local workspaces: dolt-server.port file is authoritative (bd writes it on every start).
 *   Fallback chain: metadata.json dolt_server_port -> registry port.
 */
export function resolvePort(workspace: RegistryEntry): number | null {
  if (workspace.local === null) return workspace.server?.port ?? null
  // External connections always use the registry endpoint, including when a
  // local scaffold exists. Its port file may refer to an old connection.
  if (workspace.server && getServerOwnership(workspace) !== "managed") {
    return workspace.server?.port ?? null
  }

  return resolveLocalPort(workspace.local.path) ?? workspace.server?.port ?? null
}

function resolveLocalPort(beadsDir: string): number | null {
  // Local workspace: beadsDir IS the .beads/ directory
  const portFile = join(beadsDir, "dolt-server.port")
  try {
    const portStr = readFileSync(portFile, "utf-8").trim()
    const port = parseInt(portStr, 10)
    if (Number.isFinite(port) && port > 0) {
      return port
    }
  } catch {
    // Port file missing or unreadable, try metadata.json
  }

  // Fallback: metadata.json dolt_server_port
  const metaPath = join(beadsDir, "metadata.json")
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
    if (typeof meta.dolt_server_port === "number" && meta.dolt_server_port > 0) {
      return meta.dolt_server_port
    }
  } catch {
    // metadata.json missing or unparseable
  }

  return null
}

const BD_VERSION_RE = /(\d+\.\d+\.\d+)/

export type HealthResult =
  | { ok: true; bdVersion?: string; bdPath?: string }
  | { ok: false; error: HealthError; bdVersion?: string; bdPath?: string }

// bb-fe03.6: checkHealth was 72 NLOC at CCN 16 — bd-version probe +
// version validation + server-only branch + local branch with
// classify-and-auto-recover error handling. Extracted into helpers
// below; checkHealth itself is a thin orchestrator.

interface BdProbeResult {
  ok: boolean
  version?: string
}

async function probeBdVersion(bdPath: string): Promise<BdProbeResult> {
  return execFileAsync(bdPath, ["--version"], { timeout: 5000 })
    .then(({ stdout }) => {
      const match = stdout.match(BD_VERSION_RE)
      return { ok: true as const, version: match ? match[1] : stdout.trim() }
    })
    .catch((err) => {
      const code = (err as { code?: string })?.code
      console.warn(
        `[ws:health] bd --version failed: code=${code}, ${err instanceof Error ? err.message : err}`,
      )
      return { ok: false as const, version: undefined }
    })
}

// Returns a HealthResult error if the bd version is too old; otherwise null.
function validateBdVersion(bdResult: BdProbeResult, bdPath: string): HealthResult | null {
  if (!bdResult.ok || !bdResult.version) return null
  const match = bdResult.version.match(BD_VERSION_RE)
  if (!match || compareVersions(match[1], MIN_BD_VERSION) >= 0) return null
  return {
    ok: false,
    error: { kind: "bd_version_too_old", current: match[1], required: MIN_BD_VERSION },
    bdVersion: match[1],
    bdPath,
  }
}

// Server-only workspaces: connect via MySQL directly (bd sql requires a
// local .beads/ directory which server-only workspaces don't have).
// After validating, create a local scaffold so bd CLI works for data loading.
async function checkServerOnlyWorkspace(
  workspace: RegistryEntry & { server: NonNullable<RegistryEntry["server"]> },
  bdResult: BdProbeResult,
  bdPath: string,
): Promise<HealthResult> {
  const s = workspace.server
  if (isBeadboxScaffold(workspace)) {
    try {
      await ensureExternalScaffold(workspace.local!.path, s)
    } catch (error) {
      return {
        ok: false,
        error: { kind: "unknown", message: error instanceof Error ? error.message : String(error), bdOutput: "" },
        bdVersion: bdResult.version,
        bdPath,
      }
    }
  }
  const serverKey = `${s.host}:${s.port}/${s.database}/${s.user}`
  const password = getWorkspacePassword(serverKey)
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection({
      host: s.host,
      port: s.port,
      database: s.database,
      user: s.user,
      password: password || undefined,
      ssl: s.tls ? {} : undefined,
      connectTimeout: 5000,
    })
    await conn.query("SELECT 1")
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: classifyHealthError(message, "", workspace),
      bdVersion: bdResult.version,
      bdPath,
    }
  } finally {
    await conn?.end().catch(() => {})
  }

  if (workspace.local) return { ok: true, bdVersion: bdResult.version, bdPath }

  // MySQL connection succeeded. Create a local .beads/ scaffold so bd CLI
  // commands (list, show, config) work for data loading. Without this,
  // bd fails with "no beads database found".
  try {
    const registryDir = dirname(getBeadboxRegistryPath())
    const scaffoldDir = join(registryDir, "workspaces", workspace.id)
    await mkdir(scaffoldDir, { recursive: true })
    await initServerScaffold(
      scaffoldDir,
      { host: s.host, port: s.port, database: s.database, user: s.user },
      password,
    )
    const localBeadsPath = join(scaffoldDir, ".beads")
    await updateWorkspaceLocal(workspace.id, localBeadsPath)
    // Update the in-memory entry so resolveBdDbPath uses the scaffold
    workspace.local = { path: localBeadsPath }
    console.log(
      `[ws:health] created scaffold for server workspace "${workspace.name}" at ${scaffoldDir}`,
    )
  } catch (err) {
    console.warn(
      `[ws:health] scaffold creation failed for "${workspace.name}": ${err instanceof Error ? err.message : err}`,
    )
  }

  return { ok: true, bdVersion: bdResult.version, bdPath }
}

function buildHealthEnv(workspace: RegistryEntry): NodeJS.ProcessEnv | undefined {
  // For server-backed workspaces (scaffolds), inject the password into bd's env.
  // The password is stored under the server identity key (host:port/database/user),
  // not the scaffold project path.
  if (!workspace.server) return undefined
  const serverKey = `${workspace.server.host}:${workspace.server.port}/${workspace.server.database}/${workspace.server.user}`
  const serverPassword = getWorkspacePassword(serverKey)
  if (!serverPassword) return undefined
  return { ...process.env, BEADS_DOLT_PASSWORD: serverPassword }
}

// Pulls the bd-CLI error envelope (stderr warnings stripped, stdout JSON
// preserved for the classifier) off a thrown execFileAsync error.
function extractBdError(err: unknown): { message: string; stderr: string; stdout: string } {
  const message = err instanceof Error ? err.message : String(err)
  const rawStderr =
    err && typeof err === "object" && "stderr" in err
      ? String((err as { stderr: unknown }).stderr)
      : ""
  const stdout =
    err && typeof err === "object" && "stdout" in err
      ? String((err as { stdout: unknown }).stdout)
      : ""
  return { message, stderr: stripBdWarnings(rawStderr), stdout }
}

// Auto-recovery for local workspaces with a dead Dolt server: bd dolt start
// + drain stale pool + retry the original health check. Returns true if
// recovery succeeded (caller returns ok=true), false if it failed (caller
// returns the original classified error).
async function tryAutoRecoverDolt(
  workspace: RegistryEntry,
  bdPath: string,
  dbPath: string,
  healthEnv: NodeJS.ProcessEnv | undefined,
): Promise<boolean> {
  const doltDbPath = normalizeDbPathForDolt(dbPath)
  console.log(
    `[ws:health] "${workspace.name}" → attempting auto-recovery via bd dolt start --db ${doltDbPath}`,
  )
  try {
    await execFileAsync(bdPath, ["dolt", "start", "--db", doltDbPath], {
      timeout: HEALTH_TIMEOUT_MS,
    })
    console.log(`[ws:health] "${workspace.name}" → bd dolt start succeeded, retrying health check`)
    await drainPool(dbPath).catch(() => {})
    await execFileAsync(bdPath, ["list", "--db", doltDbPath, "--json", "--limit", "1"], {
      timeout: HEALTH_TIMEOUT_MS,
      env: healthEnv,
    })
    console.log(`[ws:health] "${workspace.name}" → recovered`)
    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(
      `[ws:health] "${workspace.name}" → recovery attempt failed: ${msg.slice(0, 200)}`,
    )
    return false
  }
}

async function checkLocalWorkspace(
  workspace: RegistryEntry,
  bdResult: BdProbeResult,
  bdPath: string,
): Promise<HealthResult> {
  const dbPath = resolveBdDbPath(workspace)
  const resolvedPort = resolvePort(workspace)
  console.log(
    `[ws:health] "${workspace.name}" dbPath=${dbPath} server=${workspace.server ? `${workspace.server.host}:${resolvedPort ?? workspace.server.port}/${workspace.server.database}` : "none"}`,
  )

  const healthEnv = buildHealthEnv(workspace)

  try {
    const cmd = [bdPath, "list", "--db", dbPath, "--json", "--limit", "1"]
    console.log(`[ws:health] running: ${cmd.join(" ")}`)
    await execFileAsync(bdPath, ["list", "--db", dbPath, "--json", "--limit", "1"], {
      timeout: HEALTH_TIMEOUT_MS,
      env: healthEnv,
    })
    console.log(`[ws:health] "${workspace.name}" → ok`)
    return { ok: true, bdVersion: bdResult.version, bdPath }
  } catch (err: unknown) {
    const { message, stderr, stdout } = extractBdError(err)
    const classified = classifyHealthError(message, stderr, workspace, stdout)
    console.log(
      `[ws:health] "${workspace.name}" → FAIL kind=${classified.kind} stderr=${stderr.slice(0, 200)} stdout=${stdout.slice(0, 200)}`,
    )

    if (classified.kind === "server_unreachable" && getServerOwnership(workspace) === "managed") {
      const recovered = await tryAutoRecoverDolt(workspace, bdPath, dbPath, healthEnv)
      if (recovered) return { ok: true, bdVersion: bdResult.version, bdPath }
    }

    return { ok: false, error: classified, bdVersion: bdResult.version, bdPath }
  }
}

export async function checkHealth(workspace: RegistryEntry): Promise<HealthResult> {
  try {
    if (workspace.server && !workspace.local) {
      await workspaceTransition.preflightBdBinary()
      return await workspaceTransition.runStorageTransition(workspace.id, () =>
        checkHealthUnscoped(workspace),
      )
    }
    return await workspaceTransition.withOperation(workspace.id, async (lease) => {
      const scoped = lease.workspace as RegistryEntry
      const result = await checkHealthUnscoped(scoped)
      workspace.local = scoped.local
      return result
    })
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof Error && error.message.startsWith("bd executable "))
    ) {
      return { ok: false, error: { kind: "bd_missing" } }
    }
    return {
      ok: false,
      error: {
        kind: "unknown",
        message: error instanceof Error ? error.message : String(error),
        bdOutput: "",
      },
    }
  }
}

async function checkHealthUnscoped(workspace: RegistryEntry): Promise<HealthResult> {
  // bd v1.0.0+ embeds Dolt directly (go-mysql-server + doltcore as Go imports);
  // no standalone `dolt` binary is required at runtime. Only bd needs to be
  // present on PATH (bb-cu2n).
  const bdPath = resolveBdPath()
  const bdResult = await probeBdVersion(bdPath)

  const versionFail = validateBdVersion(bdResult, bdPath)
  if (versionFail) return versionFail

  if (workspace.server && getServerOwnership(workspace) !== "managed") {
    return checkServerOnlyWorkspace(
      workspace as RegistryEntry & { server: NonNullable<RegistryEntry["server"]> },
      bdResult,
      bdPath,
    )
  }

  return checkLocalWorkspace(workspace, bdResult, bdPath)
}

export function classifyHealthError(
  message: string,
  stderr: string,
  workspace: RegistryEntry,
  stdout: string = "",
): HealthError {
  // stdout holds the JSON error body for --json failures. Include it in the
  // search corpus so classifiers can match on the actual error text, not just
  // the generic "Command failed" wrapper in message.
  const rawCombined = `${message}\n${stderr}\n${stdout}`
  const combined = rawCombined.toLowerCase()

  // Schema migration needed: bd 1.0.1+ added new columns (e.g. started_at)
  // that older workspaces lack until `bd migrate` runs. Must come before the
  // generic "database not found" / "server_unreachable" patterns because the
  // stdout JSON can include the word "database". Match against raw text so
  // the captured column name preserves its original case for display.
  //
  // The raw stdout from bd is JSON-escaped, so quotes around the column name
  // arrive as literal `\"` sequences. Allow backslashes, quotes, or nothing
  // around the column identifier (bd output may evolve).
  const columnMatch = rawCombined.match(/column\s+\\?["`']?(\w+)\\?["`']?\s+could not be found/i)
  if (columnMatch) {
    const workspacePath = workspace.local?.path ?? ""
    return { kind: "schema_migration_needed", workspacePath, missingColumn: columnMatch[1] }
  }

  // MySQL 1045 (28000): Access denied for user 'root'@'127.0.0.1' (using password: YES)
  // Must come before other patterns that might match "access denied" text.
  if (
    combined.includes("access denied") ||
    combined.includes("error 1045") ||
    combined.includes("(28000)")
  ) {
    if (workspace.server) {
      const s = workspace.server
      const port = s.port ?? resolvePort(workspace) ?? undefined
      const user = s.user ?? "root"
      const database = s.database ?? "unknown"
      const host = s.host ?? "127.0.0.1"
      const credentialKey = `${host}:${port}/${database}/${user}`
      const passwordMapKey = `${host}:${port}/${database}`
      return { kind: "access_denied", host, port, database, user, credentialKey, passwordMapKey }
    }
    // Fallback for non-server workspaces (unlikely but safe)
    const host = "127.0.0.1"
    const port = resolvePort(workspace) ?? undefined
    return { kind: "server_unreachable", host, port }
  }

  // bd reports "no beads database found" when it can't locate a local .beads/
  // directory. For server-only workspaces (local === null), this means bd
  // couldn't resolve the workspace at all. Classify as database_missing so
  // the error screen shows recovery actions (Remove/Choose workspace).
  if (combined.includes("no beads database")) {
    if (workspace.server) {
      return { kind: "database_missing", database: workspace.server.database ?? "unknown" }
    }
    // workspace.server is null here (local workspace); use defaults
    const port = resolvePort(workspace) ?? undefined
    return { kind: "server_unreachable", host: "127.0.0.1", port }
  }

  // bd reports "Dolt server unreachable ... auto-start failed" when the dolt
  // server isn't running and bd can't start it. The auto-start failure message
  // often includes "no such file or directory" (for a lock file or socket),
  // which would false-positive on the ENOENT check below. Match this first.
  if (combined.includes("unreachable") || combined.includes("auto-start failed")) {
    const host = workspace.server?.host ?? "127.0.0.1"
    const port = workspace.server?.port ?? resolvePort(workspace) ?? undefined
    return { kind: "server_unreachable", host, port }
  }

  // bd outputs: "dolt circuit breaker is open: server appears down, failing fast (cooldown 30s)"
  // Without this pattern, circuit breaker errors fall through to "unknown" and users see
  // a generic "Startup error" instead of the actionable "Database server unreachable" screen.
  if (combined.includes("circuit breaker")) {
    const host = workspace.server?.host ?? "127.0.0.1"
    const port = workspace.server?.port ?? resolvePort(workspace) ?? undefined
    return { kind: "server_unreachable", host, port }
  }

  if (
    combined.includes("command not found") ||
    combined.includes("enoent") ||
    combined.includes("enoexec") ||
    combined.includes("no such file")
  ) {
    return { kind: "bd_missing" }
  }

  if (
    combined.includes("connect") &&
    (combined.includes("refused") || combined.includes("timeout") || combined.includes("dial"))
  ) {
    const host = workspace.server?.host ?? "127.0.0.1"
    const port = workspace.server?.port ?? resolvePort(workspace) ?? undefined
    return { kind: "server_unreachable", host, port }
  }

  if (
    combined.includes("database") &&
    (combined.includes("not found") || combined.includes("does not exist"))
  ) {
    // Prefer server block; fall back to "beads" (bd's DefaultDoltDatabase).
    const database = workspace.server?.database ?? "beads"
    return { kind: "database_missing", database }
  }

  // bd (cobra CLI) prints help/usage text when it receives an unknown flag.
  // This happens when the installed bd version is older than what Beadbox expects.
  if (
    (combined.includes("usage:") && combined.includes("flags:")) ||
    combined.includes("unknown flag") ||
    combined.includes("unknown command") ||
    combined.includes("unknown shorthand flag")
  ) {
    return { kind: "bd_outdated" }
  }

  if (
    combined.includes("timeout") ||
    combined.includes("etimedout") ||
    combined.includes("killed")
  ) {
    return { kind: "timeout" }
  }

  return { kind: "unknown", message, bdOutput: stderr || message }
}
