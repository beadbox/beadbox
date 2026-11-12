// kkrpc handler mirror of actions/health.ts (P1.3 / bb-vy13.3).
//
// Parity contract: every export of actions/health.ts is mirrored here with
// identical signatures and return shapes.

import { homedir } from "os"
import { isAbsolute, resolve } from "path"
import { __resetBdVersionCache } from "../lib/bd"
import { flagArg } from "../lib/bd-argv"
import {
  type BdPathSource,
  COMMON_BD_PATHS,
  getCandidateBdPaths,
  resetPathCaches,
  resolveBdPath,
  resolveBdPathDetail,
} from "../lib/bd-paths"
import {
  type BdValidationErrorCode,
  probeBdBinary,
  validateBdBinary,
  writeSavedBdPath,
} from "../lib/bd-settings"
import { invalidateEpicCache } from "../lib/epic-cache"
import { execFileAsync } from "../lib/exec"
import { isValidDbPath } from "../lib/path-validation"
import { resetServeReadsForBdPathChange } from "../lib/serve-reads"
import type { HealthError } from "../lib/startup-machine"
import type { Workspace } from "../lib/types"
import { compareVersions, MIN_BD_VERSION } from "../lib/version-requirements"
import { checkHealth, resolvePort } from "../lib/workspace-health"
import type { RegistryEntry, RegistryQuarantine } from "../lib/workspace-registry"
import {
  findWorkspace,
  getRegistryQuarantine,
  projectDirFromDatabasePath,
  readRegistry,
  removeWorkspaceFromRegistry,
  resolveBdDbPath,
} from "../lib/workspace-registry"
import { prefetchEpicData } from "./epics"
import {
  registeredPaths,
  restartAllSubscriptions,
  stopWorkspaceSubscriptions,
} from "./subscribe-internals"

// ---------------------------------------------------------------------------
// checkBdHealth - used by workspaces page, mid-session checks
// ---------------------------------------------------------------------------

interface BdHealthResult {
  bdAvailable: boolean
  bdVersion?: string
  bdPath?: string
  platform: string
  paths_checked?: string[]
  resolved_path?: string
  error_detail?: string
  error_type?: string
}

const BD_VERSION_RE = /(\d+\.\d+\.\d+)/

export async function checkBdHealth(): Promise<BdHealthResult> {
  const bdPath = resolveBdPath()
  try {
    const { stdout } = await execFileAsync(bdPath, ["--version"], {
      timeout: 5000,
    })
    const match = stdout.match(BD_VERSION_RE)
    return {
      bdAvailable: true,
      bdVersion: match ? match[1] : stdout.trim(),
      bdPath,
      platform: process.platform,
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const errCode =
      err && typeof err === "object" && "code" in err
        ? String((err as NodeJS.ErrnoException).code)
        : "UNKNOWN"
    const home = homedir()
    const sanitize = (p: string) => (p.startsWith(home) ? "~" + p.slice(home.length) : p)
    const candidates =
      typeof getCandidateBdPaths === "function" ? getCandidateBdPaths() : COMMON_BD_PATHS
    return {
      bdAvailable: false,
      platform: process.platform,
      paths_checked: candidates.map(sanitize),
      resolved_path: sanitize(bdPath),
      error_detail: errMsg,
      error_type: errCode,
    }
  }
}

// ---------------------------------------------------------------------------
// getToolVersions - used by posthog-provider and settings panel
// ---------------------------------------------------------------------------

export interface ToolVersions {
  bd_version: string | null
}

export async function getToolVersions(): Promise<ToolVersions> {
  const result: ToolVersions = { bd_version: null }

  try {
    const bdPath = resolveBdPath()
    const { stdout } = await execFileAsync(bdPath, ["version", "--json"], { timeout: 5000 })
    const parsed = JSON.parse(stdout)
    result.bd_version = parsed.version ?? null
  } catch {
    try {
      const bdPath = resolveBdPath()
      const { stdout } = await execFileAsync(bdPath, ["--version"], { timeout: 5000 })
      const match = stdout.match(/(\d+\.\d+\.\d+)/)
      result.bd_version = match ? match[1] : null
    } catch {
      /* ignore */
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// getWorkspaceCount - lightweight registry read for posthog-provider
// ---------------------------------------------------------------------------

export async function getWorkspaceCount(): Promise<number> {
  try {
    const registry = await readRegistry()
    return registry.workspaces.length
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// runStartupHealth - single entry point for startup gate
// ---------------------------------------------------------------------------

interface StartupHealthResult {
  hasWorkspaces: boolean
  workspaces: Workspace[]
  activeWorkspaceId?: string
  healthCheck?: { ok: true } | { ok: false; error: HealthError }
  platform: string
  bdVersion?: string
  bdPath?: string
  doltVersion?: string
  /** Set when the registry file was unusable and moved aside this session. */
  registryQuarantine?: RegistryQuarantine
}

function registryEntryToWorkspace(entry: RegistryEntry): Workspace {
  const dbPath = resolveBdDbPath(entry)
  const projectDir = entry.local ? projectDirFromDatabasePath(entry.local.path) : null
  return {
    id: entry.id,
    name: entry.name,
    path: projectDir,
    databasePath: dbPath,
    available: true,
    mode: entry.mode,
    serverHost: entry.server?.host,
    serverPort: resolvePort(entry) ?? entry.server?.port,
    serverDatabase: entry.server?.database,
    serverUser: entry.server?.user,
    serverTls: entry.server?.tls,
  }
}

// ---------------------------------------------------------------------------
// removeActiveWorkspace - remove stale workspace from registry during startup
// ---------------------------------------------------------------------------

export async function removeActiveWorkspace(
  workspaceId: string,
): Promise<{ removed: boolean; credentialKey?: string }> {
  // Look up credentialKey before removing so the client can clean up keychain
  const registry = await readRegistry()
  const entry = registry.workspaces.find((w) => w.id === workspaceId)
  const credentialKey = entry?.credentialKey
  const removed = await removeWorkspaceFromRegistry(workspaceId)
  // beadbox-wja: a removed workspace keeps no change detection running.
  if (removed && entry) await stopWorkspaceSubscriptions(registeredPaths(entry))
  return { removed, credentialKey }
}

// ---------------------------------------------------------------------------
// runWorkspaceMigration - apply pending schema migrations for a workspace
// ---------------------------------------------------------------------------

export interface MigrationResult {
  ok: boolean
  stdout?: string
  stderr?: string
  error?: string
}

/**
 * Run `bd migrate --yes` against a workspace to apply pending schema
 * migrations. Used by the schema_migration_needed error screen so the user
 * can recover without leaving Beadbox. --yes auto-confirms the interactive
 * prompt; bd migrate is idempotent when the schema is already up to date.
 *
 * This is a webview-callable WRITE, so the path is validated before bd is
 * spawned (beadbox-226): it must be an absolute .beads path (the siblings'
 * isValidDbPath check, plus isAbsolute, which isValidDbPath does not enforce)
 * AND a registered local workspace. The client only ever sends back the
 * workspacePath the server gave it, which is a registered local.path, so
 * anything else is refused. bd receives the registered path, not the client's.
 */
export async function runWorkspaceMigration(workspacePath: string): Promise<MigrationResult> {
  if (!workspacePath) {
    return { ok: false, error: "Missing workspace path" }
  }
  if (!isAbsolute(workspacePath) || !isValidDbPath(workspacePath)) {
    return {
      ok: false,
      error: `Invalid database path: ${workspacePath} (must be a .beads directory or a file inside one)`,
    }
  }
  const registry = await readRegistry()
  const target = resolve(workspacePath)
  const entry = registry.workspaces.find((w) => w.local && resolve(w.local.path) === target)
  if (!entry?.local) {
    return {
      ok: false,
      error: `Invalid database path: ${workspacePath} (not a registered workspace)`,
    }
  }
  const bdPath = resolveBdPath()
  try {
    const { stdout, stderr } = await execFileAsync(
      bdPath,
      ["migrate", flagArg("--db", entry.local.path), "--yes"],
      { timeout: 60_000 },
    )
    return { ok: true, stdout, stderr }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: e.stdout,
      stderr: e.stderr,
      error: e.message ?? String(err),
    }
  }
}

export async function runStartupHealth(cookieWorkspaceId?: string): Promise<StartupHealthResult> {
  // Clear cached paths so Retry after installing a tool re-probes the filesystem
  resetPathCaches()

  const registry = await readRegistry()
  const registryQuarantine = getRegistryQuarantine() ?? undefined

  if (registry.workspaces.length === 0) {
    return { hasWorkspaces: false, workspaces: [], platform: process.platform, registryQuarantine }
  }

  // Resolve target workspace: cookie UUID -> registry activeWorkspace -> first entry
  let target: RegistryEntry | null = null
  let activeWorkspaceId: string | undefined

  if (cookieWorkspaceId) {
    target = findWorkspace(registry, cookieWorkspaceId)
  }
  if (!target && registry.activeWorkspace) {
    target = findWorkspace(registry, registry.activeWorkspace)
    if (target) {
      activeWorkspaceId = target.id
    }
  }
  if (!target) {
    target = registry.workspaces[0]
    activeWorkspaceId = target.id
  }

  if (!activeWorkspaceId && target) {
    activeWorkspaceId = target.id
  }

  const healthResult = await checkHealth(target)
  const healthCheck = healthResult.ok
    ? { ok: true as const }
    : { ok: false as const, error: healthResult.error }

  // Build workspace list AFTER health check: checkHealth may create a local
  // scaffold for server-only workspaces (mutating target.local), and the
  // workspace list needs to reflect the updated databasePath.
  const workspaces = registry.workspaces.map(registryEntryToWorkspace)

  // Start prefetching epic data while the health result travels to the client.
  // By the time page.tsx mounts and calls getEpics(), the data is ready.
  if (healthResult.ok) {
    const dbPath = resolveBdDbPath(target)
    prefetchEpicData(dbPath)
  }

  return {
    hasWorkspaces: true,
    workspaces,
    activeWorkspaceId,
    healthCheck,
    platform: process.platform,
    bdVersion: healthResult.bdVersion,
    bdPath: healthResult.bdPath,
    registryQuarantine,
  }
}

// ---------------------------------------------------------------------------
// Per-user bd path configuration & provenance (beadbox-7vo)
// ---------------------------------------------------------------------------

export interface BdPathInfo {
  effectivePath: string
  source: BdPathSource
  envPath: string | null
  savedPath: string | null
  bdAvailable: boolean
  bdVersion: string | null
  minVersion: string
  platform: string
  statusError: string | null
  statusErrorCode: BdValidationErrorCode | null
}

export type SetBdPathResult =
  | { ok: true; info: BdPathInfo }
  | {
      ok: false
      code: BdValidationErrorCode
      error: string
      currentVersion?: string
      requiredVersion?: string
    }

async function applyBdPathRuntimeChange(): Promise<void> {
  resetPathCaches()
  __resetBdVersionCache()
  invalidateEpicCache()
  await resetServeReadsForBdPathChange()
  await restartAllSubscriptions()
}

export async function getBdPathInfo(): Promise<BdPathInfo> {
  const detail = resolveBdPathDetail()
  if (detail.effectivePath === "bd") {
    const probe = await probeBdBinary("bd")
    if (!probe.ok) {
      return {
        ...detail,
        bdAvailable: false,
        bdVersion: null,
        minVersion: MIN_BD_VERSION,
        platform: process.platform,
        statusError:
          probe.kind === "timeout"
            ? "Timed out probing bd on PATH."
            : "bd executable was not found in automatic detection locations or PATH.",
        statusErrorCode: probe.kind === "timeout" ? "probe_timeout" : "not_found",
      }
    }
    if (compareVersions(probe.version, MIN_BD_VERSION) < 0) {
      return {
        ...detail,
        bdAvailable: true,
        bdVersion: probe.version,
        minVersion: MIN_BD_VERSION,
        platform: process.platform,
        statusError: `bd v${MIN_BD_VERSION} or later is required (found v${probe.version}).`,
        statusErrorCode: "version_too_old",
      }
    }
    return {
      ...detail,
      bdAvailable: true,
      bdVersion: probe.version,
      minVersion: MIN_BD_VERSION,
      platform: process.platform,
      statusError: null,
      statusErrorCode: null,
    }
  }

  const check = await validateBdBinary(detail.effectivePath)
  if (check.ok) {
    return {
      ...detail,
      bdAvailable: true,
      bdVersion: check.version,
      minVersion: MIN_BD_VERSION,
      platform: process.platform,
      statusError: null,
      statusErrorCode: null,
    }
  }

  return {
    ...detail,
    bdAvailable: check.code === "version_too_old",
    bdVersion: check.currentVersion ?? null,
    minVersion: MIN_BD_VERSION,
    platform: process.platform,
    statusError: check.error,
    statusErrorCode: check.code,
  }
}

export async function setBdPath(path: string | null): Promise<SetBdPathResult> {
  if (path === null) {
    await writeSavedBdPath(null)
    await applyBdPathRuntimeChange()
    return { ok: true, info: await getBdPathInfo() }
  }

  const check = await validateBdBinary(path)
  if (!check.ok) {
    return {
      ok: false,
      code: check.code,
      error: check.error,
      currentVersion: check.currentVersion,
      requiredVersion: check.requiredVersion,
    }
  }

  await writeSavedBdPath(check.normalizedPath)
  await applyBdPathRuntimeChange()
  return { ok: true, info: await getBdPathInfo() }
}
