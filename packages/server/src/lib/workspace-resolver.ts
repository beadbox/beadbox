import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  findWorkspace,
  findWorkspaceByDbPath,
  getServerOwnership,
  type RegistryEntry,
  readRegistry,
  readWorkspaceMetadata,
  readWorkspacePortFile,
  resolveBdDbPath,
  type ServerConnection,
} from "./workspace-registry"

/** A fixed destination for one operation. Never derive routing from activeWorkspace. */
export interface WorkspaceTarget {
  readonly id: string
  readonly generation: number
  readonly mode: "server" | "embedded"
  readonly localBeadsDir: string | null
  readonly cliDbPath: string
  readonly serverConnection: Readonly<ServerConnection> | null
  readonly credentialKey: string | null
  /** Canonical physical DB group; aliases share this value. */
  readonly storageIdentity: string
}

const targetStates = new Map<string, { fingerprint: string; generation: number }>()
let generation = 0

function serverIdentity(connection: ServerConnection): string {
  // Length-delimited JSON avoids separator collisions in database names.
  const hostname = connection.host.toLowerCase().replace(/\.$/, "")
  const host = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname) ? "loopback" : hostname
  return JSON.stringify(["sql", host, connection.port, connection.database])
}

async function localIdentity(beadsDir: string): Promise<string> {
  // The Dolt directory is the physical database. A not-yet-created scaffold
  // still has a stable canonical .beads identity, but cannot be served yet.
  const doltDir = join(beadsDir, "dolt")
  const localPath = await realpath(doltDir).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return realpath(beadsDir)
  })
  return JSON.stringify(["local", localPath])
}

async function connectionFor(entry: RegistryEntry): Promise<ServerConnection | null> {
  if (entry.mode !== "server") return null
  const local = entry.local?.path
  const ownership = getServerOwnership(entry)
  if (entry.server && (!local || ownership !== "managed")) return { ...entry.server }
  if (!local) throw new Error(`Server workspace ${entry.id} has no connection`)

  const metadata = await readWorkspaceMetadata(local)
  if (metadata.parseError)
    throw new Error(`Invalid workspace metadata for ${entry.id}: ${metadata.parseError}`)
  if (metadata.mode !== "server" && !entry.server) {
    throw new Error(`Server workspace ${entry.id} has no connection`)
  }
  const port = (await readWorkspacePortFile(local)) ?? metadata.serverPort ?? entry.server?.port
  const host = metadata.serverHost ?? entry.server?.host
  const database = metadata.serverDatabase ?? entry.server?.database
  const user = metadata.serverUser ?? entry.server?.user
  if (!host || !port || !database || !user) {
    throw new Error(`Server workspace ${entry.id} has an incomplete connection`)
  }
  return { host, port, database, user, tls: metadata.serverTls ?? entry.server?.tls ?? false }
}

/** Resolve UUID or transitional dbPath against the latest registry contents. */
export async function resolveWorkspaceTarget(idOrPath: string): Promise<WorkspaceTarget> {
  const registry = await readRegistry()
  const presentIds = new Set(registry.workspaces.map((workspace) => workspace.id))
  for (const id of targetStates.keys()) {
    if (!presentIds.has(id)) targetStates.delete(id)
  }
  const entry = findWorkspace(registry, idOrPath) ?? findWorkspaceByDbPath(registry, idOrPath)
  if (!entry) throw new Error(`Workspace not found: ${idOrPath}`)

  const localBeadsDir = entry.local ? await realpath(resolve(entry.local.path)) : null
  const serverConnection = await connectionFor(entry)
  const storageIdentity = serverConnection
    ? serverIdentity(serverConnection)
    : localBeadsDir
      ? await localIdentity(localBeadsDir)
      : (() => {
          throw new Error(`Workspace ${entry.id} has no physical storage`)
        })()
  const cliDbPath = resolveBdDbPath(entry)
  const credentialKey =
    entry.credentialKey ??
    (serverConnection
      ? `${serverConnection.host}:${serverConnection.port}/${serverConnection.database}/${serverConnection.user}`
      : null)

  // Target fields that affect routing or process identity advance the local
  // generation. Display-only registry changes intentionally do not.
  const fingerprint = JSON.stringify([
    entry.mode,
    entry.serverOwnership,
    entry.server,
    localBeadsDir,
    cliDbPath,
    serverConnection,
    credentialKey,
    storageIdentity,
  ])
  let state = targetStates.get(entry.id)
  if (state?.fingerprint !== fingerprint) {
    generation += 1
    state = { fingerprint, generation }
    targetStates.set(entry.id, state)
  }
  const target: WorkspaceTarget = {
    id: entry.id,
    generation: state!.generation,
    mode: entry.mode,
    localBeadsDir,
    cliDbPath,
    serverConnection: serverConnection ? Object.freeze(serverConnection) : null,
    credentialKey,
    storageIdentity,
  }
  return Object.freeze(target)
}

/** Publish a new target after scaffold, schema, or bd binary changes. */
export function invalidateWorkspaceTarget(id?: string): void {
  if (id) targetStates.delete(id)
  else targetStates.clear()
}
