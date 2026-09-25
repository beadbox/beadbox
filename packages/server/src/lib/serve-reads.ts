// Routes reads through bd serve for workspaces that opted in (beadbox-6x2,
// landing L4). The CLI stays the source of truth and the default path:
//
//  - Only a workspace whose registry entry has serveReads === true, and that
//    is otherwise eligible (serve-eligibility.ts), is ever considered. If no
//    workspace opts in, the ServeManager is never constructed: nothing is
//    spawned and no token dir exists.
//  - No read waits for a serve start. The first eligible read starts the child
//    and the identity handshake in the background and is itself answered by
//    the CLI; later reads use serve once it is ready.
//  - Any serve failure makes that read use the CLI. An integrity failure
//    (auth, identity, contract) also stops serve for that workspace; a
//    transient one drops the connection so a later read reconnects. No
//    failure becomes an empty result.
//  - Shutdown needs no hook: every child is tied to the sidecar's stdin, so
//    it and its token dir go when the sidecar goes, however it goes
//    (serve-lifetime.test.ts).

import { basename, dirname } from "node:path"
import { resolveBdPath } from "./bd-paths"
import { serveReadEligibility } from "./serve-eligibility"
import { classifyServeFailure, ServeClient } from "./serve-http"
import { ServeManager, sweepStaleServeDirs } from "./serve-manager"
import { probeBdVersion } from "./workspace-health"
import { findWorkspaceByDbPath, type RegistryEntry, readRegistry } from "./workspace-registry"

/** One read against a connected serve client. */
export type ServeRead<T> = (client: ServeClient) => Promise<T>
/** The read's value, or null: read it through the CLI. */
export type ServeResult<T> = { value: T } | null

interface WorkspaceServe {
  client: ServeClient | null
  starting: Promise<void> | null
  disabled: string | null
}

let manager: ServeManager | null = null
const workspaces = new Map<string, WorkspaceServe>()
const bdVersionByPath = new Map<string, string | null>()

/** The .beads directory for any spelling of a workspace db path. */
function beadsDirOf(dbPath: string): string {
  if (basename(dbPath) === ".beads") return dbPath
  const parent = dirname(dbPath)
  if (basename(parent) === ".beads") return parent
  return dbPath
}

async function bdVersion(): Promise<string | null> {
  const path = resolveBdPath()
  if (!bdVersionByPath.has(path)) {
    const probe = await probeBdVersion(path)
    bdVersionByPath.set(path, probe.ok && probe.version ? probe.version : null)
  }
  return bdVersionByPath.get(path) ?? null
}

async function eligibleEntry(dbPath: string): Promise<RegistryEntry | null> {
  const beadsDir = beadsDirOf(dbPath)
  const entry = findWorkspaceByDbPath(await readRegistry(), beadsDir)
  // Cheapest check first: nothing else runs for a workspace that did not opt in.
  if (!entry || entry.serveReads !== true) return null
  const state = workspaces.get(entry.id)
  const verdict = serveReadEligibility(entry, {
    platform: process.platform,
    bdVersion: await bdVersion(),
    disabledReason: state?.disabled ?? undefined,
  })
  if (!verdict.eligible) return null
  return entry
}

function startInBackground(entry: RegistryEntry, state: WorkspaceServe): void {
  if (state.starting || state.client || state.disabled) return
  const beadsDir = entry.local?.path as string
  if (!manager) manager = new ServeManager({ bdPath: resolveBdPath })
  const m = manager
  state.starting = (async () => {
    try {
      const handle = await m.get({ key: entry.id, workspaceDir: dirname(beadsDir), env: {} })
      state.client = await ServeClient.connect(handle, { beadsDir })
    } catch (error) {
      onFailure(entry.id, state, error)
    } finally {
      state.starting = null
    }
  })()
}

function onFailure(key: string, state: WorkspaceServe, error: unknown): void {
  const cls = classifyServeFailure(error)
  const why = error instanceof Error ? error.message : String(error)
  if (cls === "integrity") {
    state.disabled = why
    state.client = null
    console.error(`[serve-reads] serve disabled for workspace ${key}: ${why}`)
    void manager?.stop(key)
  } else if (cls === "transient") {
    state.client = null
    console.warn(`[serve-reads] serve unavailable for workspace ${key}, using the CLI: ${why}`)
  }
}

/**
 * The serve result for this read, or null to mean "read it through the CLI".
 * Never waits for a serve start; never returns an empty stand-in for a failure.
 */
export async function tryServe<T>(dbPath: string | undefined, read: ServeRead<T>): Promise<ServeResult<T>> {
  if (!dbPath || dbPath.startsWith("server://")) return null
  const entry = await eligibleEntry(dbPath)
  if (!entry) return null
  let state = workspaces.get(entry.id)
  if (!state) {
    state = { client: null, starting: null, disabled: null }
    workspaces.set(entry.id, state)
  }
  if (!state.client) {
    startInBackground(entry, state)
    return null
  }
  try {
    return { value: await read(state.client) }
  } catch (error) {
    onFailure(entry.id, state, error)
    return null
  }
}

/** Sidecar start: remove token dirs a previous sidecar could not clean up. */
export function sweepServeDirsAtStartup(): void {
  const removed = sweepStaleServeDirs(undefined, manager?.liveTokenDirs() ?? new Set())
  if (removed.length) console.error(`[serve-reads] removed ${removed.length} stale serve token dir(s)`)
}

/** @internal tests only */
export function __serveReadsState(): { managerConstructed: boolean; workspaces: Map<string, WorkspaceServe> } {
  return { managerConstructed: manager !== null, workspaces }
}

/** @internal tests only */
export async function __resetServeReads(): Promise<void> {
  await manager?.stopAll()
  manager = null
  workspaces.clear()
  bdVersionByPath.clear()
}

/** @internal tests only: wait for any background starts to settle. */
export async function __settleServeStarts(): Promise<void> {
  await Promise.all([...workspaces.values()].map((s) => s.starting ?? Promise.resolve()))
}
