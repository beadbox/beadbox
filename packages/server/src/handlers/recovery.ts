// Recovery sidecar handlers.
//
// Destructive surface: runRecoveryCommand can wipe a workspace (init
// --from-jsonl), and migrateToServerMode rebuilds the database. The
// handlers require callers to have already confirmed at the UI layer —
// no auto-confirm in the sidecar.

import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { buildEnv, getBdPath } from "../lib/bd"
import { isValidDbPath } from "../lib/path-validation"
import { findWorkspaceByDbPath, getBeadboxRegistryPath, getServerOwnership, type WorkspaceRegistry } from "../lib/workspace-registry"
import { resolveWorkspaceTarget } from "../lib/workspace-resolver"
import { workspaceTransition } from "../lib/workspace-transition"

const execFileAsync = promisify(execFile)

// Pre-approved commands that the recovery UI is allowed to execute.
// Maps the user-facing command string to the actual bd CLI argument array.
const ALLOWED_FIX_COMMANDS: Record<string, string[]> = {
  "bd init --from-jsonl": ["init", "--from-jsonl"],
  "bd dolt stop": ["dolt", "stop"],
  "bd dolt start": ["dolt", "start"],
  "bd init": ["init"],
}

// Normalize .beads/ directory paths to .beads/dolt for Dolt server mode.
// Same logic as lib/bd.ts normalizeDbPath (not exported).
function normalizeDbPath(dbPath: string): string {
  if (basename(dbPath) === ".beads") {
    return join(dbPath, "dolt")
  }
  return dbPath
}

// Derive the project root from a db path that contains .beads/.
// Same logic as lib/bd.ts projectRootFromDb (not exported).
function projectRootFromDb(dbPath: string): string | undefined {
  const normalized = normalizeDbPath(dbPath)
  const parent = dirname(normalized)
  if (basename(parent) === ".beads") {
    return dirname(parent)
  }
  return undefined
}

function isExternallyManaged(databasePath: string): boolean {
  let registry: WorkspaceRegistry
  try {
    registry = JSON.parse(readFileSync(getBeadboxRegistryPath(), "utf-8")) as WorkspaceRegistry
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  const beadsDir = databasePath.startsWith("server://")
    ? databasePath
    : basename(databasePath) === ".beads"
      ? databasePath
      : dirname(databasePath)
  const entry = findWorkspaceByDbPath(registry, beadsDir)
  return !!entry?.server && getServerOwnership(entry) !== "managed"
}

export async function runRecoveryCommand(
  command: string,
  databasePath: string,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const args = ALLOWED_FIX_COMMANDS[command]
  if (!args) {
    return { success: false, error: "Unknown command" }
  }

  if (!isValidDbPath(databasePath)) {
    return {
      success: false,
      error: `Invalid database path: ${databasePath} (must be a .beads directory or a file inside one)`,
    }
  }

  if (isExternallyManaged(databasePath)) {
    return { success: false, error: "Recovery commands are unavailable for an externally managed Dolt server" }
  }

  let targetId: string
  try {
    targetId = (await resolveWorkspaceTarget(databasePath)).id
    await workspaceTransition.preflightBdBinary()
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return await workspaceTransition.runStorageTransition(targetId, () =>
      executeRecoveryCommand(args, databasePath),
    )
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function executeRecoveryCommand(
  args: string[],
  databasePath: string,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const bdPath = getBdPath()
  const normalizedDb = normalizeDbPath(databasePath)
  const cwd = projectRootFromDb(databasePath)

  try {
    const { stdout } = await execFileAsync(bdPath, [...args, "--db", normalizedDb], {
      timeout: 30_000,
      cwd,
      env: buildEnv({ db: databasePath }),
    })
    return { success: true, output: stdout.trim() }
  } catch (error: unknown) {
    const execError = error as { stderr?: string; message?: string }
    return {
      success: false,
      error: execError.stderr?.trim() || execError.message || "Command failed",
    }
  }
}

// Read the issue prefix from metadata.json (dolt_database field).
async function readPrefix(dbPath: string): Promise<string> {
  const normalized = normalizeDbPath(dbPath)
  const beadsDir =
    basename(dirname(normalized)) === ".beads"
      ? dirname(normalized)
      : basename(normalized) === ".beads"
        ? normalized
        : dirname(normalized)
  const metaPath = join(beadsDir, "metadata.json")
  const raw = await readFile(metaPath, "utf-8")
  const meta = JSON.parse(raw) as { dolt_database?: string }
  return meta.dolt_database ?? "beads"
}

export type MigrationStep = "backup" | "reinit" | "restore"

export interface MigrationProgress {
  step: MigrationStep
  done: boolean
  error?: string
}

/**
 * Migrate an embedded-mode workspace to server mode.
 *
 * Sequence:
 * 1. bd backup (export JSONL)
 * 2. bd init --server --prefix <prefix> (re-init as server)
 * 3. bd backup restore (import data into server-mode database)
 *
 * Returns success/failure with the step that failed (if any).
 */
export async function migrateToServerMode(
  databasePath: string,
): Promise<{ success: boolean; failedStep?: MigrationStep; error?: string }> {
  if (!isValidDbPath(databasePath)) {
    return {
      success: false,
      error: `Invalid database path: ${databasePath} (must be a .beads directory or a file inside one)`,
    }
  }

  if (isExternallyManaged(databasePath)) {
    return { success: false, error: "Migration is unavailable for an externally managed Dolt server" }
  }

  let prefix: string
  try {
    prefix = await readPrefix(databasePath)
  } catch {
    return {
      success: false,
      failedStep: "backup",
      error: "Could not read workspace prefix from metadata.json",
    }
  }

  let targetId: string
  try {
    targetId = (await resolveWorkspaceTarget(databasePath)).id
    await workspaceTransition.preflightBdBinary()
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return await workspaceTransition.runStorageTransition(targetId, () =>
      executeMigration(databasePath, prefix),
    )
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function executeMigration(
  databasePath: string,
  prefix: string,
): Promise<{ success: boolean; failedStep?: MigrationStep; error?: string }> {
  const bdPath = getBdPath()
  const normalizedDb = normalizeDbPath(databasePath)
  const cwd = projectRootFromDb(databasePath)

  const run = async (args: string[], timeoutMs = 60_000) => {
    const { stdout, stderr } = await execFileAsync(bdPath, [...args, "--db", normalizedDb], {
      timeout: timeoutMs,
      cwd,
    })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  }

  // Step 1: backup
  try {
    await run(["backup", "sync"])
  } catch (error: unknown) {
    const e = error as { stderr?: string; message?: string }
    return {
      success: false,
      failedStep: "backup",
      error: e.stderr?.trim() || e.message || "Backup failed",
    }
  }

  // Step 2: re-init as server mode
  try {
    await run(["init", "--server", "--prefix", prefix, "--force", "--non-interactive"], 120_000)
  } catch (error: unknown) {
    const e = error as { stderr?: string; message?: string }
    return {
      success: false,
      failedStep: "reinit",
      error: e.stderr?.trim() || e.message || "Re-init as server mode failed",
    }
  }

  // Step 3: restore data
  try {
    await run(["backup", "restore", "--force"])
  } catch (error: unknown) {
    const e = error as { stderr?: string; message?: string }
    return {
      success: false,
      failedStep: "restore",
      error: e.stderr?.trim() || e.message || "Backup restore failed",
    }
  }

  return { success: true }
}
