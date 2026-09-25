import { randomUUID } from "crypto"
import { readFileSync, realpathSync } from "fs"
import { mkdir, readFile, rename, stat, unlink, writeFile } from "fs/promises"
import { homedir } from "os"
import { basename, dirname, join, resolve } from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerConnection {
  host: string
  port: number
  database: string
  user: string
  tls: boolean
}

// v2 registry entry with UUID identity
export interface RegistryEntry {
  id: string // UUID, assigned at creation, immutable
  name: string // display name (user-editable)
  icon?: string // user-chosen emoji shown on the workspace tab; absent = default glyph
  addedAt: string // ISO 8601
  local: { path: string } | null // null for server-only
  server: ServerConnection | null // null for local-only
  mode: "server" | "embedded"
  // A local .beads scaffold is also used for externally managed servers.
  // Server lifecycle ownership must therefore be independent of `local`.
  serverOwnership?: "external" | "managed" | "unknown"
  credentialKey?: string // OS keychain account name (host:port/database/user)
}

export type ServerOwnership = NonNullable<RegistryEntry["serverOwnership"]>

export function isBeadboxScaffold(entry: RegistryEntry): boolean {
  if (!entry.local) return false
  const scaffoldPath = join(dirname(getBeadboxRegistryPath()), "workspaces", entry.id, ".beads")
  return resolve(entry.local.path) === resolve(scaffoldPath)
}

/** Infer ownership for old registry entries, failing closed when provenance is unclear. */
export function getServerOwnership(entry: RegistryEntry): ServerOwnership | null {
  if (!entry.server) return null
  if (entry.serverOwnership) return entry.serverOwnership
  if (!entry.local) return "external"

  if (isBeadboxScaffold(entry)) return "external"

  try {
    const metadata = JSON.parse(readFileSync(join(entry.local.path, "metadata.json"), "utf-8"))
    if (typeof metadata.dolt_server_port === "number") return "external"
    if (
      metadata.dolt_server_host &&
      !["127.0.0.1", "localhost", "::1"].includes(metadata.dolt_server_host)
    ) {
      return "external"
    }
    return metadata.dolt_mode === "server" ? "managed" : "unknown"
  } catch {
    return "unknown"
  }
}

function persistInferredOwnership(registry: WorkspaceRegistry): boolean {
  let changed = false
  for (const entry of registry.workspaces) {
    if (!entry.server || entry.serverOwnership) continue
    entry.serverOwnership = getServerOwnership(entry) ?? "unknown"
    changed = true
  }
  return changed
}

export interface WorkspaceRegistry {
  version: 2
  activeWorkspace: string | null // UUID
  workspaces: RegistryEntry[]
}

// Legacy v1 types for migration
interface V1RegistryEntry {
  path: string | null
  name: string
  addedAt: string
  server?: ServerConnection
}

interface V1Registry {
  workspaces: V1RegistryEntry[]
  activeWorkspace: string | null // was a path or serverWorkspaceId
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the path to the beadbox workspace registry file.
 * Respects BEADBOX_REGISTRY_PATH env var for test isolation.
 */
export function getBeadboxRegistryPath(): string {
  return process.env.BEADBOX_REGISTRY_PATH || join(homedir(), ".beadbox", "registry.json")
}

/**
 * Returns the path to the legacy bd workspace registry for migration.
 * Respects BEADS_REGISTRY_PATH env var for test isolation.
 */
function getLegacyRegistryPath(): string {
  return process.env.BEADS_REGISTRY_PATH || join(homedir(), ".beads", "registry.json")
}

// ---------------------------------------------------------------------------
// UUID generation & lookup
// ---------------------------------------------------------------------------

export function generateWorkspaceId(): string {
  return randomUUID()
}

export function findWorkspace(registry: WorkspaceRegistry, id: string): RegistryEntry | null {
  return registry.workspaces.find((w) => w.id === id) ?? null
}

/**
 * Find a workspace by its databasePath (local path, server runtime path, or server:// URI).
 * Used as a transitional adapter while callers still pass databasePath instead of UUID.
 */
export function findWorkspaceByDbPath(
  registry: WorkspaceRegistry,
  databasePath: string,
): RegistryEntry | null {
  // Legacy paths omit UUID (and server:// also omits user and TLS). Never
  // silently choose an entry when multiple registry records match.
  let matches: RegistryEntry[]
  if (databasePath.startsWith("server://")) {
    matches = registry.workspaces.filter(
      (entry) =>
        entry.server &&
        `server://${entry.server.host}:${entry.server.port}/${entry.server.database}` ===
          databasePath,
    )
  } else {
    const path = resolve(databasePath)
    const normalized = basename(dirname(path)) === ".beads" ? dirname(path) : path
    const canonical = (candidate: string) => {
      try {
        return realpathSync(candidate)
      } catch {
        return resolve(candidate)
      }
    }
    matches = registry.workspaces.filter(
      (entry) => entry.local && canonical(entry.local.path) === canonical(normalized),
    )
  }
  if (matches.length > 1) throw new Error(`Ambiguous workspace database path: ${databasePath}`)
  return matches[0] ?? null
}

/** Resolve a scaffold-backed external connection from a bd database path. */
export function findExternalWorkspaceByDbPath(dbPath: string): RegistryEntry | null {
  if (dbPath.startsWith("server://")) return null
  let registry: WorkspaceRegistry
  try {
    registry = JSON.parse(readFileSync(getBeadboxRegistryPath(), "utf-8")) as WorkspaceRegistry
  } catch {
    return null
  }
  if (!Array.isArray(registry.workspaces)) return null
  const entry = findWorkspaceByDbPath(registry, dbPath)
  return entry && getServerOwnership(entry) === "external" ? entry : null
}

/**
 * Derive the db identifier for bd CLI from a registry entry.
 * Server-only -> server:// URI (bd uses env vars), local -> local.path.
 */
export function resolveBdDbPath(entry: RegistryEntry): string {
  if (entry.mode === "server" && !entry.local && entry.server) {
    return `server://${entry.server.host}:${entry.server.port}/${entry.server.database}`
  }
  if (entry.local) return join(entry.local.path, "beads.db")
  throw new Error(`Workspace ${entry.id} has no local path and no server connection`)
}

// ---------------------------------------------------------------------------
// Workspace metadata
// ---------------------------------------------------------------------------

export interface WorkspaceMetadata {
  mode: "server" | "embedded"
  serverHost?: string
  serverPort?: number
  serverDatabase?: string
  serverUser?: string
  serverTls?: boolean
  parseError?: string
}

export async function readWorkspacePortFile(beadsDir: string): Promise<number | null> {
  try {
    const value = (await readFile(join(beadsDir, "dolt-server.port"), "utf-8")).trim()
    if (!/^\d+$/.test(value)) return null
    const port = Number(value)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

export async function readWorkspaceMetadata(beadsDir: string): Promise<WorkspaceMetadata> {
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
      parseError:
        "metadata.json exists but could not be parsed: " +
        (err instanceof Error ? err.message : String(err)),
    }
  }
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function emptyRegistry(): WorkspaceRegistry {
  return { version: 2, workspaces: [], activeWorkspace: null }
}

/**
 * Read the beadbox workspace registry. Returns empty v2 registry if file is
 * missing. Detects v1 format and auto-migrates to v2 with UUID identity.
 * On first run (file doesn't exist), attempts one-time migration from
 * the legacy ~/.beads/registry.json.
 */
export async function readRegistry(): Promise<WorkspaceRegistry> {
  return serializeRegistryTask(async () => {
    const { registry, migrated } = await readRegistryUnqueued()
    if (migrated) {
      // Persist the migration inside the same queued task that produced it, so
      // nothing can slip between the migration and its write, and the ids it
      // minted are what every later read (and the client's cookie) sees.
      // A failure keeps the read available — the next read re-migrates.
      try {
        await writeRegistryFile(registry)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`[beadbox-registry] could not persist migrated registry: ${reason}`)
      }
    }
    return registry
  })
}

/**
 * The read itself, with no queue involvement. Only for code that already holds
 * the queue (mutateRegistry) — the exported readRegistry is a queued task and
 * would deadlock if awaited from inside another one. `migrated` is true when
 * the registry on disk is not the v2 shape returned here (a v1 file, or the
 * legacy ~/.beads registry) and therefore still needs to be written.
 */
async function readRegistryUnqueued(): Promise<{ registry: WorkspaceRegistry; migrated: boolean }> {
  const registryPath = getBeadboxRegistryPath()

  let content: string | null = null
  try {
    content = await readFile(registryPath, "utf-8")
  } catch (error) {
    // Only "the file isn't there" means first run. Every other failure
    // (EACCES, EISDIR, EIO) must propagate: falling through hands the caller
    // an empty registry, and mutateRegistry would then persist that emptiness
    // over a file we merely failed to read — the rename makes it permanent.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  if (content !== null) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      // The file exists but is not JSON. Returning an empty registry here
      // silently drops every workspace the user registered and the next write
      // makes that permanent, so move the bytes aside and say so loudly.
      const reason = error instanceof Error ? error.message : String(error)
      await quarantineUnreadableRegistry(registryPath, `not valid JSON: ${reason}`)
    }

    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      await quarantineUnreadableRegistry(registryPath, "root is not a JSON object")
      parsed = null
    }

    // Migration and dedup run OUTSIDE the quarantine block on purpose: a
    // registry that parses fine but holds one odd entry is a bug to survive,
    // not a reason to rename the user's whole file away.
    if (parsed !== null) {
      const record = parsed as Partial<WorkspaceRegistry> & Partial<V1Registry>
      if (record.version === 2) {
        const registry = filterInvalidEntries(parsed as WorkspaceRegistry)
        return { registry, migrated: persistInferredOwnership(registry) }
      }
      // v1 registry (no version field): migrate
      const v1: V1Registry = {
        workspaces: Array.isArray(record.workspaces)
          ? (record.workspaces as V1RegistryEntry[])
          : [],
        activeWorkspace: typeof record.activeWorkspace === "string" ? record.activeWorkspace : null,
      }
      const registry = filterInvalidEntries(migrateV1ToV2(v1))
      persistInferredOwnership(registry)
      return { registry, migrated: true }
    }
  }

  // No registry (or an unusable one): attempt migration from legacy registry
  const legacy = await migrateFromLegacyRegistry()
  if (legacy.workspaces.length > 0) {
    const registry = filterInvalidEntries(
      migrateV1ToV2({
        workspaces: legacy.workspaces,
        activeWorkspace: legacy.activeWorkspace,
      }),
    )
    persistInferredOwnership(registry)
    return { registry, migrated: true }
  }
  return { registry: emptyRegistry(), migrated: false }
}

async function quarantineUnreadableRegistry(registryPath: string, reason: string): Promise<void> {
  try {
    await stat(registryPath)
    const quarantined = `${registryPath}.corrupt-${Date.now()}`
    await rename(registryPath, quarantined)
    console.error(`[beadbox-registry] registry is unusable (${reason}); moved to ${quarantined}`)
  } catch {
    console.error(`[beadbox-registry] registry is unreadable (${reason})`)
  }
}

/**
 * Remove structurally unusable entries. Shared physical storage is allowed:
 * distinct UUIDs must remain visible so legacy lookups can reject ambiguity.
 */
function filterInvalidEntries(registry: WorkspaceRegistry): WorkspaceRegistry {
  // Runs on whatever JSON.parse produced, so nothing here may throw on an odd
  // shape: a hand-edited or half-migrated registry must lose the bad entry,
  // not send the caller down the "corrupt file" path.
  if (!Array.isArray(registry.workspaces)) registry.workspaces = []

  registry.workspaces = registry.workspaces.filter((entry) => {
    if (!entry || typeof entry !== "object") return false
    if (entry.local) {
      if (typeof entry.local.path !== "string") return false
    }
    return true
  })

  return registry
}

// Every registry mutation is a read-modify-write of one small JSON file, and
// the sidecar handles rpc calls concurrently: two overlapping mutations (e.g.
// "rename this workspace" landing next to "set its icon") used to interleave,
// losing one update and — because writeFile truncates in place — leaving a
// half-written file on disk that no longer parses. Both mutations now run
// under this process-wide queue, and the bytes land via tmp-file + rename so
// a reader never observes a partial registry.
let registryQueue: Promise<unknown> = Promise.resolve()

function serializeRegistryTask<T>(task: () => Promise<T>): Promise<T> {
  const run = registryQueue.then(task, task)
  registryQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function writeRegistryFile(registry: WorkspaceRegistry): Promise<void> {
  const registryPath = getBeadboxRegistryPath()
  await mkdir(dirname(registryPath), { recursive: true })
  // Unguessable name + "wx" so the write cannot land on a file or symlink
  // someone else planted at a predictable path; 0600 because the registry
  // lists every project directory on the machine.
  const tmpPath = `${registryPath}.${randomUUID()}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify(registry, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    })
    await rename(tmpPath, registryPath)
  } catch (error) {
    // A failed write must not leave a stray tmp file next to the registry.
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/**
 * Write the registry atomically (mkdir -p the parent dir first).
 * Serialized against every other registry write in this process.
 */
export async function writeRegistry(registry: WorkspaceRegistry): Promise<void> {
  await serializeRegistryTask(() => writeRegistryFile(registry))
}

/**
 * Read-modify-write the registry under the process-wide registry lock.
 * `mutate` sees a registry nobody else is writing; its return value is
 * passed through to the caller once the new contents are on disk.
 *
 * MUST be used by every mutation instead of readRegistry() + writeRegistry():
 * that pair leaves a window in which a concurrent mutation is lost.
 *
 * `mutate` MUST NOT call another exported mutator (addWorkspace,
 * setActiveWorkspace, updateWorkspaceLabel, ...) or the exported readRegistry:
 * all of them are queued tasks and the queue is a single non-reentrant chain,
 * so a nested task waits for the task that is already holding it and both
 * hang forever. Inside a task, read with readRegistryUnqueued.
 *
 * The queue is per-process. A second sidecar process writing the same file is
 * not serialized against this one; the skip-if-unchanged below and the
 * tmp-file + rename keep that case from corrupting the file or reverting an
 * untouched field, but this is not a cross-process lock.
 */
export async function mutateRegistry<T>(
  mutate: (registry: WorkspaceRegistry) => T | Promise<T>,
): Promise<T> {
  return serializeRegistryTask(async () => {
    // Unqueued on purpose: this task already holds the queue, and the exported
    // readRegistry is itself a queued task.
    const { registry, migrated } = await readRegistryUnqueued()
    const before = JSON.stringify(registry)
    const result = await mutate(registry)
    // Skip the write when the mutator changed nothing (unknown workspace id,
    // empty patch, remove of an absent entry). Rewriting the whole file for a
    // no-op would clobber whatever another process wrote since our read.
    // A migrated read is the exception: the v2 shape is not on disk yet, and
    // this task is the one place it can be written without a second writer.
    if (migrated || JSON.stringify(registry) !== before) await writeRegistryFile(registry)
    return result
  })
}

// ---------------------------------------------------------------------------
// v1 -> v2 Migration
// ---------------------------------------------------------------------------

function migrateV1ToV2(v1: V1Registry): WorkspaceRegistry {
  const idMap = new Map<string, string>() // old path/serverWorkspaceId -> new UUID
  const workspaces: RegistryEntry[] = v1.workspaces.map((entry) => {
    const id = generateWorkspaceId()
    // Map old identity formats to the new UUID
    if (entry.path) idMap.set(entry.path, id)
    if (entry.server) {
      idMap.set(serverWorkspaceId(entry.server), id)
    }

    return {
      id,
      name: entry.name,
      addedAt: entry.addedAt,
      local: entry.path ? { path: entry.path } : null,
      server: entry.server ?? null,
      mode: (entry.server ? "server" : "embedded") as "server" | "embedded",
    }
  })

  // Resolve activeWorkspace: look up old path/id in the idMap
  let activeWorkspace: string | null = null
  if (v1.activeWorkspace) {
    activeWorkspace = idMap.get(v1.activeWorkspace) ?? null
  }

  // Pure: persisting the migrated registry is the reader's job (see
  // readRegistry / mutateRegistry). This used to fire a write of its own; once
  // writes were serialized (#33) that write queued BEHIND any mutation already
  // waiting and reverted it with this pre-mutation snapshot (beadbox-6q7).
  return { version: 2, activeWorkspace, workspaces }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Add a local workspace to the registry. Deduplicates by path.
 * Generates a UUID for the new entry. Returns the UUID (existing or new).
 */
export async function addWorkspace(databasePath: string, name: string): Promise<string> {
  const normalizedPath = resolve(databasePath)
  return mutateRegistry((registry) => {
    const existing = registry.workspaces.find(
      (w) => w.local !== null && resolve(w.local.path) === normalizedPath,
    )
    if (existing) return existing.id

    const id = generateWorkspaceId()
    registry.workspaces.push({
      id,
      name,
      addedAt: new Date().toISOString(),
      local: { path: normalizedPath },
      server: null,
      mode: "embedded",
    })
    console.log(`[beadbox-registry] added workspace: ${name} (${normalizedPath})`)
    return id
  })
}

/**
 * Add or update a server-only workspace in the registry.
 * Deduplicates by server identity (host+port+database).
 * If a matching entry exists, updates its server block in place.
 */
export async function addServerWorkspaceEntry(
  name: string,
  server: ServerConnection,
): Promise<string> {
  const credentialKey = `${server.host}:${server.port}/${server.database}/${server.user}`
  return mutateRegistry((registry) => {
    // Check for existing entry with same server identity
    const existing = registry.workspaces.find(
      (w) =>
        w.server &&
        w.server.host === server.host &&
        w.server.port === server.port &&
        w.server.database === server.database,
    )

    if (existing) {
      // Update server block in place
      existing.server = server
      existing.name = name
      existing.serverOwnership = "external"
      existing.credentialKey = credentialKey
      console.log(
        `[beadbox-registry] updated server workspace: ${name} (${server.host}:${server.port}/${server.database})`,
      )
      return existing.id
    }

    const id = generateWorkspaceId()
    registry.workspaces.push({
      id,
      name,
      addedAt: new Date().toISOString(),
      local: null,
      server,
      mode: "server",
      serverOwnership: "external",
      credentialKey,
    })
    console.log(
      `[beadbox-registry] added server workspace: ${name} (${server.host}:${server.port}/${server.database})`,
    )
    return id
  })
}

/**
 * Atomically replace a local workspace with a server-only workspace.
 * Removes the old entry and inserts a new server entry in one write.
 * Preserves activeWorkspace if it pointed to the old entry (transfers to new).
 * Returns the new workspace UUID, or null if oldId was not found.
 */
export async function replaceWorkspace(
  oldId: string,
  name: string,
  server: ServerConnection,
): Promise<string | null> {
  return mutateRegistry((registry) => {
    const oldIdx = registry.workspaces.findIndex((w) => w.id === oldId)
    if (oldIdx < 0) return null

    const newId = generateWorkspaceId()
    const wasActive = registry.activeWorkspace === oldId

    // Remove old entry, insert new server entry at same position
    registry.workspaces.splice(oldIdx, 1, {
      id: newId,
      name,
      addedAt: new Date().toISOString(),
      local: null,
      server,
      mode: "server",
      serverOwnership: "external",
      credentialKey: `${server.host}:${server.port}/${server.database}/${server.user}`,
    })

    if (wasActive) registry.activeWorkspace = newId

    console.log(
      `[beadbox-registry] replaced workspace ${oldId} with server entry: ${name} (${server.host}:${server.port}/${server.database})`,
    )
    return newId
  })
}

/**
 * Update a workspace's local path (e.g., after creating a scaffold for a server workspace).
 */
export async function updateWorkspaceLocal(workspaceId: string, localPath: string): Promise<void> {
  await mutateRegistry((registry) => {
    const entry = registry.workspaces.find((w) => w.id === workspaceId)
    if (entry) entry.local = { path: localPath }
  })
}

/**
 * Update a workspace's display label: name and/or icon (emoji).
 * `icon: null` clears the icon. Returns the updated entry, or null when the
 * workspace id is unknown.
 */
export async function updateWorkspaceLabel(
  workspaceId: string,
  label: { name?: string; icon?: string | null },
): Promise<RegistryEntry | null> {
  return mutateRegistry((registry) => {
    const entry = registry.workspaces.find((w) => w.id === workspaceId)
    if (!entry) return null
    if (label.name !== undefined) entry.name = label.name
    if (label.icon === null) delete entry.icon
    else if (label.icon !== undefined) entry.icon = label.icon
    console.log(`[beadbox-registry] relabeled workspace ${workspaceId}: ${entry.name}`)
    return entry
  })
}

/**
 * Remove a workspace from the registry by UUID.
 * Returns true if found and removed, false if not found.
 */
export async function removeWorkspaceFromRegistry(workspaceId: string): Promise<boolean> {
  return mutateRegistry((registry) => {
    const before = registry.workspaces.length
    registry.workspaces = registry.workspaces.filter((w) => w.id !== workspaceId)

    if (registry.workspaces.length === before) return false

    // If the removed workspace was active, clear it
    if (registry.activeWorkspace === workspaceId) {
      registry.activeWorkspace = null
    }

    console.log(`[beadbox-registry] removed workspace: ${workspaceId}`)
    return true
  })
}

/**
 * Update a workspace's server connection and mode in the registry.
 * Used to backfill the server block for local-path workspaces that
 * operate in server mode (detected from metadata.json after registration).
 */
export async function updateWorkspaceServer(
  workspaceId: string,
  server: ServerConnection,
): Promise<void> {
  await mutateRegistry((registry) => {
    const entry = registry.workspaces.find((w) => w.id === workspaceId)
    if (!entry) return
    entry.server = server
    entry.mode = "server"
    entry.serverOwnership ??= getServerOwnership(entry) ?? "unknown"
  })
}

/**
 * Set the active workspace in the registry by UUID.
 */
export async function setActiveWorkspace(workspaceId: string): Promise<void> {
  await mutateRegistry((registry) => {
    registry.activeWorkspace = workspaceId
  })
}

/**
 * Get the active workspace UUID from the registry.
 */
export async function getActiveWorkspace(): Promise<string | null> {
  const registry = await readRegistry()
  return registry.activeWorkspace
}

// ---------------------------------------------------------------------------
// Migration from legacy ~/.beads/registry.json
// ---------------------------------------------------------------------------

/**
 * One-time migration: read legacy ~/.beads/registry.json (bd daemon format)
 * and convert to v1 beadbox format. Returns the intermediate v1 entries
 * (caller will run v1->v2 migration).
 */
async function migrateFromLegacyRegistry(): Promise<V1Registry> {
  const legacyPath = getLegacyRegistryPath()

  try {
    const content = await readFile(legacyPath, "utf-8")
    const parsed = JSON.parse(content)
    const entries = Array.isArray(parsed) ? parsed : []

    if (entries.length === 0) return { workspaces: [], activeWorkspace: null }

    const now = new Date().toISOString()
    const workspaces: V1RegistryEntry[] = entries
      .filter((e: Record<string, unknown>) => e.database_path && e.workspace_path)
      .map((e: Record<string, unknown>) => ({
        path: e.database_path as string,
        name: basename(e.workspace_path as string),
        addedAt: now,
      }))

    if (workspaces.length === 0) return { workspaces: [], activeWorkspace: null }

    console.log(
      `[beadbox-registry] migrated ${workspaces.length} workspace(s) from legacy registry`,
    )
    return { workspaces, activeWorkspace: null }
  } catch {
    // Legacy registry doesn't exist or can't be read - that's fine
    return { workspaces: [], activeWorkspace: null }
  }
}

// ---------------------------------------------------------------------------
// Server-only workspace identity & runtime paths
// ---------------------------------------------------------------------------

/**
 * Stable identifier for a server-only workspace: "host:port/database".
 * Used during migration to map old IDs to new UUIDs. Not used as identity
 * in v2 (UUID replaces this).
 */
export function serverWorkspaceId(server: ServerConnection): string {
  return `${server.host}:${server.port}/${server.database}`
}

/**
 * Parse a server:// URI back into a ServerConnection.
 * Format: server://host:port/database
 * Returns null if the URI is not a valid server:// URI.
 */
export function parseServerUri(uri: string): ServerConnection | null {
  if (!uri.startsWith("server://")) return null
  const rest = uri.slice("server://".length)
  const colonIdx = rest.indexOf(":")
  const slashIdx = rest.indexOf("/")
  if (colonIdx < 0 || slashIdx < 0 || slashIdx <= colonIdx) return null
  const host = rest.slice(0, colonIdx)
  const port = parseInt(rest.slice(colonIdx + 1, slashIdx), 10)
  const database = rest.slice(slashIdx + 1)
  if (!host || !Number.isFinite(port) || !database) return null
  return { host, port, database, user: "root", tls: false }
}

// ---------------------------------------------------------------------------
// Utility: derive project directory from a database path
// ---------------------------------------------------------------------------

/**
 * Given a databasePath ("/foo/bar/.beads" or "/foo/bar/.beads/beads.db"),
 * return the project directory ("/foo/bar").
 */
export function projectDirFromDatabasePath(databasePath: string): string {
  const resolved = resolve(databasePath)
  if (basename(resolved) === ".beads") return dirname(resolved)
  // .db file: parent is .beads/, grandparent is project dir
  return dirname(dirname(resolved))
}
