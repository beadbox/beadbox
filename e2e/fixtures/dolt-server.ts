/**
 * Reusable Dolt server lifecycle module for E2E tests.
 *
 * Provides binary discovery, server start/stop/restart, workspace seeding,
 * and shared bd CLI helpers. Used by global-setup.ts (template creation)
 * and test-setup.ts (per-worker servers).
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs"
import { createConnection } from "net"
import { basename, dirname, join } from "path"
import { homedir, tmpdir } from "os"

/** Synchronous sleep without spawning a child process. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

export function findBd(): string {
  if (process.env.BD_PATH) return process.env.BD_PATH
  const common = [
    "/opt/homebrew/bin/bd",
    "/usr/local/bin/bd",
    join(homedir(), "go/bin/bd"),
    join(homedir(), ".local/bin/bd"),
    "/usr/bin/bd",
  ]
  for (const p of common) {
    if (existsSync(p)) return p
  }
  return "bd"
}

export function findDolt(): string {
  if (process.env.DOLT_PATH) return process.env.DOLT_PATH
  const common = [
    "/usr/local/bin/dolt",
    "/opt/homebrew/bin/dolt",
    join(homedir(), "go/bin/dolt"),
    join(homedir(), ".local/bin/dolt"),
    "/usr/bin/dolt",
  ]
  for (const p of common) {
    if (existsSync(p)) return p
  }
  return "dolt"
}

// Resolved paths (cached at module load)
const BD_PATH = findBd()
const DOLT_PATH = findDolt()

/**
 * Environment for the bd and Dolt processes these helpers spawn. The headless
 * harness (beadbox-r72.3) sets E2E_HOME to a scratch home per run, so no child
 * can read or write the real home (bd's registry, ~/.beadbox, Dolt's global
 * config). Without E2E_HOME this is process.env, as before.
 */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = process.env.E2E_HOME ? { HOME: process.env.E2E_HOME } : {}
  return { ...process.env, ...home, ...extra }
}

// ---------------------------------------------------------------------------
// bd CLI helpers
// ---------------------------------------------------------------------------

// Normalize .beads directory paths to .beads/dolt for the bd CLI --db flag.
// bd expects --db to point inside .beads/ (e.g. .beads/dolt or .beads/beads.db),
// not the directory itself. Mirrors lib/bd.ts normalizeDbPath.
function normalizeDbPath(dbPath: string): string {
  if (basename(dbPath) === ".beads") return join(dbPath, "dolt")
  return dbPath
}

// Derive the project root from a db path containing .beads/.
// Mirrors lib/bd.ts projectRootFromDb so bd writes last-touched to the correct workspace.
function projectRootFromDb(dbPath: string): string | undefined {
  const normalized = normalizeDbPath(dbPath)
  const parent = dirname(normalized)
  if (basename(parent) === ".beads") return dirname(parent)
  return undefined
}

/**
 * Run a bd command against a workspace database, routing to a specific Dolt server port.
 *
 * For `bd list` commands, --flat is always appended because bd's tree renderer
 * ignores --json without --flat, returning human-readable text instead of JSON.
 */
export function bd(dbPath: string, args: string[], doltPort?: number): string {
  const env: NodeJS.ProcessEnv = childEnv()
  if (doltPort !== undefined) {
    env.BEADS_DOLT_SERVER_PORT = String(doltPort)
    // Also set HOST so bd uses the existing server instead of trying to
    // start its own. Without this, bd may kill the test's managed Dolt.
    env.BEADS_DOLT_SERVER_HOST = "127.0.0.1"
  }
  const finalArgs = [...args]
  if (finalArgs[0] === "list" && !finalArgs.includes("--flat")) {
    finalArgs.push("--flat")
  }
  return execFileSync(BD_PATH, ["--db", normalizeDbPath(dbPath), ...finalArgs], {
    encoding: "utf-8",
    env,
    cwd: projectRootFromDb(dbPath),
    timeout: 30_000,
  })
}

/** Run bd create and return the created issue ID. */
export function bdCreate(dbPath: string, args: string[], doltPort?: number): string {
  const output = bd(dbPath, ["create", ...args], doltPort)
  const match = output.match(/Created issue:\s+(\S+)/)
  if (!match) throw new Error(`Failed to parse issue ID from: ${output}`)
  return match[1]
}

// ---------------------------------------------------------------------------
// Dolt server lifecycle
// ---------------------------------------------------------------------------

/** Check if a TCP port has a listener (synchronous, no child process). */
function isPortInUse(port: number): boolean {
  try {
    const result = spawnSync("node", ["-e", `
      const s = require("net").createConnection({port:${port},host:"127.0.0.1"});
      s.on("connect",()=>{s.destroy();process.exit(0)});
      s.on("error",()=>process.exit(1));
      setTimeout(()=>process.exit(1),500);
    `], { timeout: 2000, stdio: "ignore" })
    return result.status === 0
  } catch { return false }
}

/**
 * Block until the given port is confirmed unreachable (ECONNREFUSED).
 * Polls every intervalMs up to timeoutMs. Throws if the port is still
 * reachable after the deadline. Used after doltServerControl.stop() to
 * guard against respawn races: the test must not proceed
 * until Dolt is actually down.
 */
export function waitForPortUnreachable(port: number, timeoutMs = 10_000, intervalMs = 200): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPortInUse(port)) return
    killProcessOnPort(port)
    sleepMs(intervalMs)
  }
  throw new Error(`Port ${port} still reachable after ${timeoutMs}ms`)
}

/** Kill any process listening on the given TCP port (stale servers from prior runs). */
export function killProcessOnPort(port: number): void {
  if (!isPortInUse(port)) return
  try {
    const result = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf-8", timeout: 5000 })
    const pids = (result.stdout || "").trim().split("\n").filter(Boolean)
    for (const pid of pids) {
      try { process.kill(Number(pid), "SIGKILL") } catch { /* already dead */ }
    }
    if (pids.length > 0) sleepMs(500)
  } catch {
    // lsof not available or failed; proceed and let port-bind fail naturally
  }
}

export interface DoltServerHandle {
  /** The child process running dolt sql-server. */
  process: ChildProcess
  /** The port the server is listening on. */
  port: number
  /** The data directory containing Dolt databases. */
  dataDir: string
}

/**
 * Remove stale Dolt state files left behind by a crashed (SIGKILL'd) server.
 * Specifically: the Unix socket and per-database LOCK files in .dolt/noms/.
 * If these persist, the new server may fail to load databases entirely.
 */
function cleanStaleDoltState(dataDir: string): void {
  // Remove stale Unix socket
  const socketPath = join(dataDir, "dolt.sock")
  try { rmSync(socketPath, { force: true }) } catch { /* best-effort */ }

  // Remove stale sql-server.info
  const serverInfoPath = join(dataDir, ".dolt", "sql-server.info")
  try { rmSync(serverInfoPath, { force: true }) } catch { /* best-effort */ }

  // Remove LOCK files from each database's noms directory.
  // After SIGKILL, these file locks are released by the OS but the files
  // remain, and Dolt may refuse to load the database on restart.
  try {
    for (const entry of readdirSync(dataDir)) {
      if (entry.startsWith(".")) continue
      const lockPath = join(dataDir, entry, ".dolt", "noms", "LOCK")
      try { rmSync(lockPath, { force: true }) } catch { /* best-effort */ }
      // Also clean stats LOCK
      const statsLockPath = join(dataDir, entry, ".dolt", "stats", ".dolt", "noms", "LOCK")
      try { rmSync(statsLockPath, { force: true }) } catch { /* best-effort */ }
    }
  } catch { /* dataDir might not have subdirectories yet */ }
}

/**
 * Start a Dolt sql-server on the given port with the given data directory.
 * Polls until the server accepts MySQL connections (up to 30s).
 * Returns a handle with the child process, port, and data directory.
 */
export function startDoltServer(
  port: number,
  dataDir: string,
  readinessQuery = "SELECT 1",
  { killPortFirst = true }: { killPortFirst?: boolean } = {},
): DoltServerHandle {
  // Kill any stale process on this port before starting.
  // A leftover dolt server from a previous test run would accept our poll
  // but serve data from a different data-dir, silently corrupting tests.
  // The headless harness passes killPortFirst: false: it kills only pids it
  // spawned (beadbox-r72.3), and its ports come fresh from findFreePort().
  if (killPortFirst) killProcessOnPort(port)

  // Clean up stale state from previous Dolt server instances.
  // After SIGKILL, the Unix socket and database LOCK files may remain,
  // preventing the new server from loading databases.
  cleanStaleDoltState(dataDir)

  const socketPath = join(dataDir, "dolt.sock")
  const child = spawn(DOLT_PATH, [
    "sql-server",
    `--port=${port}`,
    `--data-dir=${dataDir}`,
    `--socket=${socketPath}`,
    "--loglevel=error",
  ], { stdio: "ignore", detached: false, env: childEnv() })

  // Poll until server accepts connections (up to 30s).
  // Also verify the child process hasn't exited (e.g. port conflict).
  // NOTE: We use process.kill(pid, 0) instead of child.exitCode because
  // Atomics.wait (used in sleepMs) blocks the event loop, preventing
  // SIGCHLD from updating exitCode. kill(0) is a synchronous POSIX check.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.pid !== undefined) {
      try { process.kill(child.pid, 0) } catch {
        throw new Error(
          `Dolt server process died before accepting connections on port ${port}`
        )
      }
    }
    const result = spawnSync(DOLT_PATH, [
      "--host", "127.0.0.1",
      "--port", String(port),
      "--user", "root",
      "-p", "",
      "--no-tls",
      "sql", "-q", readinessQuery,
    ], { timeout: 2000, stdio: "ignore", env: childEnv() })
    if (result.status === 0) return { process: child, port, dataDir }
    sleepMs(100)
  }
  child.kill()
  throw new Error(`Dolt server on port ${port} failed to start within 30s`)
}

// System databases that Dolt always creates (not user data).
const DOLT_SYSTEM_DATABASES = new Set(["dolt", "information_schema", "mysql"])

/**
 * After a Dolt server restart, wait until at least one user database has its
 * `issues` table accessible. SHOW DATABASES discovers which databases loaded
 * (not all may survive SIGKILL restarts), then we probe each for the table.
 * This avoids hardcoding a database name that might not load after crash recovery.
 */
export function waitForTablesReady(port: number, timeoutMs = 30_000): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // Get list of loaded databases
    const dbResult = spawnSync(DOLT_PATH, [
      "--host", "127.0.0.1", "--port", String(port),
      "--user", "root", "-p", "", "--no-tls",
      "sql", "-q", "SHOW DATABASES",
    ], { timeout: 2000, encoding: "utf-8" })
    if (dbResult.status !== 0) { sleepMs(200); continue }

    // Parse database names from the output table
    const lines = (dbResult.stdout || "").split("\n")
    const dbNames = lines
      .filter(l => l.startsWith("| ") && !l.includes("Database"))
      .map(l => l.replace(/[| ]/g, "").trim())
      .filter(name => name && !DOLT_SYSTEM_DATABASES.has(name))

    // ALL non-system databases must have their issues table accessible.
    // Returning on the first success allowed later databases (e.g. 'e2e')
    // to still be initializing when tests started, causing 'database not found'.
    const allReady = dbNames.length > 0 && dbNames.every(db => {
      const tableResult = spawnSync(DOLT_PATH, [
        "--host", "127.0.0.1", "--port", String(port),
        "--user", "root", "-p", "", "--no-tls",
        "sql", "-q", `SELECT 1 FROM \`${db}\`.issues LIMIT 0`,
      ], { timeout: 2000, stdio: "ignore" })
      return tableResult.status === 0
    })
    if (allReady) return
    sleepMs(200)
  }
  throw new Error(`Dolt server tables not ready on port ${port} within ${timeoutMs}ms`)
}

/**
 * Stop a running Dolt server. Sends SIGTERM and waits briefly,
 * then escalates to SIGKILL if still alive.
 */
export function stopDoltServer(handle: DoltServerHandle | ChildProcess): void {
  const child = "process" in handle ? handle.process : handle
  child.kill("SIGTERM")
  // Give it a moment to flush
  sleepMs(200)
  if (!child.killed) child.kill("SIGKILL")
}

// ---------------------------------------------------------------------------
// Managed Dolt server (with temp dir lifecycle)
// ---------------------------------------------------------------------------

export interface ManagedDoltServer {
  /** Host the server listens on. Always 127.0.0.1. */
  host: string
  /** Port the server listens on. */
  port: number
  /** Name of the database created inside Dolt. */
  databaseName: string
  /** Data directory (temp dir managed by this fixture). */
  dataDir: string
  /** Stop the server (for server-down test scenarios). Can be restarted. */
  stop: () => void
  /** Start (or restart) the server on the same port. */
  start: () => void
  /** Whether the server is currently running. */
  isRunning: () => boolean
  /** Kill server and remove temp directory. Call this when done. */
  cleanup: () => void
}

export interface CreateManagedServerOptions {
  /** Port to use. If omitted, a random high port is chosen. */
  port?: number
  /** Database name to create. Defaults to "test". */
  databaseName?: string
}

/** Find a free TCP port by spawning a tiny Node script that binds to port 0. */
export function findFreePort(): number {
  const { execSync } = require("child_process")
  const script = `
    const s = require("net").createServer();
    s.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(s.address().port));
      s.close();
    });
  `
  const port = parseInt(execSync(`node -e '${script}'`, { encoding: "utf-8" }).trim(), 10)
  if (!port || isNaN(port)) throw new Error("Failed to find a free port")
  return port
}

/**
 * Create a managed Dolt server with its own temp directory.
 * Handles init, server start, and full lifecycle.
 */
export function createManagedDoltServer(
  options?: CreateManagedServerOptions,
): ManagedDoltServer {
  const port = options?.port ?? findFreePort()
  const databaseName = options?.databaseName ?? "test"
  const dataDir = join(tmpdir(), `dolt-fixture-${port}-${process.pid}-${Date.now()}`)

  // Create the data directory and initialize a Dolt database inside it.
  // Dolt's --data-dir expects each database to be a sub-directory that
  // has been individually `dolt init`'d.
  const dbDir = join(dataDir, databaseName)
  mkdirSync(dbDir, { recursive: true })
  spawnSync(DOLT_PATH, ["init"], { cwd: dbDir, stdio: "ignore" })

  let handle: DoltServerHandle | null = null
  let hasStartedOnce = false

  function start() {
    if (handle && !handle.process.killed) {
      throw new Error("Server is already running. Call stop() first.")
    }
    handle = startDoltServer(port, dataDir)
    // On restart, wait for database tables to be accessible.
    // First start skips this because tables don't exist yet pre-seed.
    if (hasStartedOnce) {
      waitForTablesReady(port)
    }
    hasStartedOnce = true
  }

  function stop() {
    if (!handle) throw new Error("Server is not running.")
    stopDoltServer(handle)
    handle = null
  }

  function isRunning(): boolean {
    return handle !== null && !handle.process.killed
  }

  function cleanup() {
    if (handle && !handle.process.killed) {
      stopDoltServer(handle)
      handle = null
    }
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      // Best-effort
    }
  }

  // Start the server immediately
  start()

  return {
    host: "127.0.0.1",
    port,
    databaseName,
    dataDir,
    stop,
    start,
    isRunning,
    cleanup,
  }
}

// ---------------------------------------------------------------------------
// Dolt server control (for mid-test stop/start)
// ---------------------------------------------------------------------------

export interface DoltServerControl {
  /** Stop the running Dolt server (kills the process). */
  stop: () => void
  /** Start (or restart) the Dolt server on the same port. */
  start: () => void
  /** Whether the server is currently running. */
  isRunning: () => boolean
  /** The port the server listens on. */
  port: number
}

/**
 * Verify Dolt server stability by running multiple consecutive successful
 * SQL queries. A single successful probe can pass even if the server is
 * still settling (loading databases, replaying WAL) under CI load. This
 * runs `consecutiveRequired` successful queries spaced `intervalMs` apart.
 * If any query fails, the success counter resets and retries continue
 * until the deadline.
 */
export function waitForDoltStable(
  port: number,
  timeoutMs = 30_000,
  consecutiveRequired = 3,
  intervalMs = 100,
): void {
  const deadline = Date.now() + timeoutMs
  let consecutiveOk = 0
  while (Date.now() < deadline) {
    const result = spawnSync(DOLT_PATH, [
      "--host", "127.0.0.1",
      "--port", String(port),
      "--user", "root",
      "-p", "",
      "--no-tls",
      "sql", "-q", "SELECT 1",
    ], { timeout: 2000, stdio: "ignore" })
    if (result.status === 0) {
      consecutiveOk++
      if (consecutiveOk >= consecutiveRequired) return
    } else {
      consecutiveOk = 0
    }
    sleepMs(intervalMs)
  }
  throw new Error(
    `Dolt server on port ${port} not stable (need ${consecutiveRequired} consecutive OK) within ${timeoutMs}ms`
  )
}

// ---------------------------------------------------------------------------
// Circuit breaker cleanup
// ---------------------------------------------------------------------------

/**
 * Remove the bd circuit breaker state file for a given port.
 * bd persists circuit breaker state in /tmp/beads-dolt-circuit-{port}.json.
 * After a server-health test trips the breaker, subsequent bd calls on the
 * same port fail fast with "server appears down" even after Dolt restarts.
 * Call this after restarting Dolt to ensure a clean breaker state.
 */
export function clearCircuitBreakerState(port: number): void {
  const circuitFile = join(tmpdir(), `beads-dolt-circuit-${port}.json`)
  try { rmSync(circuitFile, { force: true }) } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Workspace seeding
// ---------------------------------------------------------------------------

/**
 * Seed a server-mode workspace at the given project directory.
 * Creates .beads/ with metadata.json pointing at the Dolt server.
 * Returns a UUID that can be used as the workspace identity in v2 registries.
 */
export function seedServerWorkspace(
  host: string,
  port: number,
  dbName: string,
  projectDir: string,
): string {
  const beadsDir = join(projectDir, ".beads")
  mkdirSync(beadsDir, { recursive: true })

  // Write metadata.json for server mode
  const metadata = {
    dolt_mode: "server",
    dolt_server_host: host,
    dolt_server_port: port,
    dolt_database: dbName,
  }
  writeFileSync(join(beadsDir, "metadata.json"), JSON.stringify(metadata, null, 2))

  // Write dolt-server.port so bd CLI finds the correct server at runtime.
  writeFileSync(join(beadsDir, "dolt-server.port"), String(port))

  // Create dolt/ marker and beads.db placeholder so health checks pass.
  // In server mode the real data lives in the Dolt server, but filesystem
  // probes may look for these.
  mkdirSync(join(beadsDir, "dolt"), { recursive: true })
  const dbPath = join(beadsDir, "beads.db")
  if (!existsSync(dbPath)) writeFileSync(dbPath, "")

  return randomUUID()
}
