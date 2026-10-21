// Gates handler namespace: the Waiting view's data and its one mutation.
//
// hasOpenGate is the Waiting tab's presence check, run from every view on
// every change event, so it reads open gates only (`bd gate list`). The full
// read stays with listWaiting, which only the Waiting view itself calls: it
// reads every issue once (`bd list --include-gates`) and derives open gates
// plus the issues they hold (lib/gates.ts). resolveHumanGate runs
// `bd gate resolve`, bd's own command for closing a gate by hand, and only
// for an open human gate: timer and gh gates close through `bd gate check`.

import {
  type BdOptions,
  resolveGate as bdResolveGate,
  showBead as bdShowBead,
  listBeads,
  listOpenGates,
} from "../lib/bd"
import { readMetadataMode } from "../lib/dolt-metadata"
import { isOpenGate, resolveRefusal, waitingGates } from "../lib/gates"
import type { WaitingGate } from "../lib/types"

type Success<T> = { success: true; data: T }
type Failure = { success: false; error: string }

function extractError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A server-mode workspace runs bd in parallel; embedded mode keeps the db lock.
async function readOptions(dbPath: string | undefined): Promise<BdOptions> {
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  if (dbPath && (await readMetadataMode(dbPath)) === "server") options.parallel = true
  return options
}

/**
 * Whether the workspace has at least one open gate: the Waiting tab and
 * Cmd/Ctrl+6 exist only then. A gates-only read, never the full list. On a
 * bd that cannot answer, this fails and the client shows no tab.
 */
export async function hasOpenGate(dbPath?: string): Promise<Success<boolean> | Failure> {
  try {
    const open = await listOpenGates(await readOptions(dbPath))
    return { success: true, data: open.some(isOpenGate) }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

export async function listWaiting(dbPath?: string): Promise<Success<WaitingGate[]> | Failure> {
  try {
    const issues = await listBeads({ ...(await readOptions(dbPath)), includeSystem: true })
    return { success: true, data: waitingGates(issues) }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

// Resolves in flight, keyed by workspace and gate ID. The re-read below and
// the resolve are two bd calls; a second click (or a second window) on the
// same gate must not slip in between them and close it again over the first
// reason, which bd would allow: `bd gate resolve` re-closes a closed gate.
const resolving = new Set<string>()

/**
 * Close a human gate with `bd gate resolve`. The client sends only an ID, so
 * the gate is re-read here and everything about it is decided from bd's
 * answer, never from what the Waiting view showed (lib/gates.ts
 * resolveRefusal: the exact ID, a gate, still open, a human gate).
 */
export async function resolveHumanGate(
  id: string,
  dbPath?: string,
  reason = "",
): Promise<{ success: boolean; error?: string }> {
  if (typeof reason !== "string") return { success: false, error: "Invalid reason" }
  const options: BdOptions = dbPath ? { db: dbPath } : {}
  const key = `${dbPath ?? ""}\0${id}`
  if (resolving.has(key)) return { success: false, error: `${id} is already being resolved` }
  resolving.add(key)
  try {
    const refusal = resolveRefusal(await bdShowBead(id, options), id)
    if (refusal) return { success: false, error: refusal }
    await bdResolveGate(id, reason.trim(), options)
    return { success: true }
  } catch (error: unknown) {
    console.error("Failed to resolve gate:", error)
    return { success: false, error: extractError(error) }
  } finally {
    resolving.delete(key)
  }
}
