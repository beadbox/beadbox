// Source-local copy of lib/dolt-pool.ts (P1.3 / bb-vy13.3).
// Imports already relative; no rewrites needed.

import { readFileSync } from "fs"
import { readFile } from "fs/promises"
import mysql from "mysql2/promise"
import { basename, dirname, join } from "path"
import { getWorkspacePassword } from "./bd"
import { findExternalWorkspaceByDbPath, parseServerUri } from "./workspace-registry"

/** Thrown when dolt-server.port doesn't exist yet (server not started). */
export class PortFileMissingError extends Error {
  constructor(portFile: string) {
    super(`dolt-server.port not found: ${portFile}`)
    this.name = "PortFileMissingError"
  }
}

// Normalize .beads/ directory paths to .beads/dolt (same logic as bd.ts)
function normalizeDbPath(dbPath: string): string {
  if (basename(dbPath) === ".beads") {
    return join(dbPath, "dolt")
  }
  return dbPath
}

// Derive the project root from a db path that contains .beads/
function projectRootFromDb(dbPath: string): string | undefined {
  const normalized = normalizeDbPath(dbPath)
  const parent = dirname(normalized)
  if (basename(parent) === ".beads") {
    return dirname(parent)
  }
  return undefined
}

// Read the Dolt server port from .beads/dolt-server.port
function readDoltPort(dbPath: string): number {
  const beadsDir = dirname(normalizeDbPath(dbPath))
  const portFile = join(beadsDir, "dolt-server.port")
  let portStr: string
  try {
    portStr = readFileSync(portFile, "utf-8").trim()
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code === "ENOENT") {
      throw new PortFileMissingError(portFile)
    }
    console.error(
      `[dolt-pool] failed to read ${portFile}: code=${code}, ${err instanceof Error ? err.message : err}`,
    )
    throw err
  }
  const port = parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`[dolt-pool] invalid port value in ${portFile}: "${portStr}"`)
    throw new Error(`Invalid port in dolt-server.port: ${portStr}`)
  }
  return port
}

// Read the database name from .beads/metadata.json
async function readDoltDatabase(dbPath: string): Promise<string> {
  const beadsDir = dirname(normalizeDbPath(dbPath))
  const metaPath = join(beadsDir, "metadata.json")
  let raw: string
  try {
    raw = await readFile(metaPath, "utf-8")
  } catch (err) {
    const code = (err as { code?: string })?.code
    console.error(
      `[dolt-pool] failed to read ${metaPath}: code=${code}, ${err instanceof Error ? err.message : err}`,
    )
    throw err
  }
  let meta: { dolt_database?: string }
  try {
    meta = JSON.parse(raw)
  } catch (err) {
    console.error(
      `[dolt-pool] failed to parse ${metaPath}: ${err instanceof Error ? err.message : err}`,
    )
    throw err
  }
  if (!meta.dolt_database) {
    console.warn(`[dolt-pool] ${metaPath} missing dolt_database field, falling back to "beads"`)
    return "beads"
  }
  return meta.dolt_database
}

interface CachedPool {
  pool: mysql.Pool
  endpoint: string
}

const poolCache = new Map<string, CachedPool>()

export async function getPool(dbPath: string): Promise<mysql.Pool> {
  const key = dbPath.startsWith("server://") ? dbPath : normalizeDbPath(dbPath)
  const cached = poolCache.get(key)

  // Server-only workspace: parse connection from URI
  const server = parseServerUri(dbPath)
  const external = server ? null : findExternalWorkspaceByDbPath(dbPath)?.server
  let host: string
  let port: number
  let database: string
  let user: string
  let password: string | undefined
  let tls = false

  if (server || external) {
    const connection = server ?? external!
    host = connection.host
    port = connection.port
    database = connection.database
    user = connection.user
    tls = connection.tls
    const serverKey = `${host}:${port}/${database}`
    password = getWorkspacePassword(serverKey)
  } else {
    host = "127.0.0.1"
    port = readDoltPort(dbPath)
    database = await readDoltDatabase(dbPath)
    user = "root"
    const wsPath = projectRootFromDb(dbPath)
    password = wsPath ? getWorkspacePassword(wsPath) : undefined
  }

  const endpoint = `${host}:${port}/${database}/${user}/${tls}`
  // External connections may change host, database, or user without changing port.
  if (cached) {
    if (cached.endpoint === endpoint) {
      return cached.pool
    }
    console.log(
      `[dolt-pool] endpoint changed for ${key}: cached=${cached.endpoint} current=${endpoint}, draining stale pool`,
    )
    poolCache.delete(key)
    cached.pool.end().catch(() => {})
  }

  console.log(
    `[dolt-pool] creating pool for ${host}:${port}/${database} (user=${user}, hasPassword=${!!password})`,
  )

  const pool = mysql.createPool({
    host,
    port,
    database,
    user,
    password: password || undefined,
    ssl: tls ? {} : undefined,
    connectionLimit: 2,
    waitForConnections: true,
    connectTimeout: 5000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
  })

  // Health check
  try {
    await pool.query("SELECT 1")
    console.log(`[dolt-pool] health check passed for ${host}:${port}/${database}`)
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err))
    const code = (err as { code?: string })?.code
    const errno = (err as { errno?: number })?.errno
    console.error(
      `[dolt-pool] health check FAILED for ${host}:${port}/${database}: message=${errObj.message}, code=${code}, errno=${errno}`,
    )
    await pool.end().catch(() => {})

    // For local workspaces, check if port changed (server restarted on new port).
    // Re-read the port file; if it's different, retry once with the new port.
    if (!server && !external && isConnectionError(code, errno)) {
      try {
        const freshPort = readDoltPort(dbPath)
        if (freshPort !== port) {
          console.log(
            `[dolt-pool] port changed during health check: ${port} → ${freshPort}, retrying`,
          )
          const retryPool = mysql.createPool({
            host,
            port: freshPort,
            database,
            user,
            password: password || undefined,
            ssl: tls ? {} : undefined,
            connectionLimit: 2,
            waitForConnections: true,
            connectTimeout: 5000,
            enableKeepAlive: true,
            keepAliveInitialDelay: 30000,
          })
          try {
            await retryPool.query("SELECT 1")
            console.log(`[dolt-pool] health check passed on new port ${freshPort}`)
            poolCache.set(key, {
              pool: retryPool,
              endpoint: `${host}:${freshPort}/${database}/${user}/${tls}`,
            })
            return retryPool
          } catch {
            await retryPool.end().catch(() => {})
          }
        }
      } catch {
        // Port file unreadable or missing; fall through to throw
      }
    }

    throw new Error(`Pool health check failed for ${key}: ${errObj.message}`)
  }

  poolCache.set(key, { pool, endpoint })
  return pool
}

function isConnectionError(code: string | undefined, errno: number | undefined): boolean {
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    errno === -61 ||
    errno === -111
  )
}

export async function drainPool(dbPath: string): Promise<void> {
  const key = dbPath.startsWith("server://") ? dbPath : normalizeDbPath(dbPath)
  const cached = poolCache.get(key)
  if (!cached) return
  poolCache.delete(key)
  await cached.pool.end()
}

export async function drainAllPools(): Promise<void> {
  const entries = Array.from(poolCache.entries())
  poolCache.clear()
  await Promise.all(entries.map(([, cached]) => cached.pool.end()))
}

// For testing only
export function __getPoolCacheSize(): number {
  return poolCache.size
}
