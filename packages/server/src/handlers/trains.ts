import { listBeads, type BdOptions } from "../lib/bd"
import { beadsDirFromDatabasePath, listTrainPaths, loadAllTrains, loadJsonlStatus } from "../lib/beadtrain-fs"
import { readyViews } from "../lib/beadtrain-ready"
import { workspaceTargetOptions } from "./workspace-target-options"

type Success<T> = { success: true; data: T }
type Failure = { success: false; error: string }

function extractError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"
}

async function loadBeadStatus(
  beadsDir: string,
  options: BdOptions,
): Promise<Map<string, string> | null> {
  // bd is the source of truth. issues.jsonl is an EXPORT and can lag it, so
  // it is the fallback for when bd is unavailable, never the first choice.
  if (options.db && !options.db.startsWith("server://")) {
    try {
      const beads = await listBeads(options)
      return new Map(beads.map((bead) => [bead.id, bead.status]))
    } catch {
      /* fall through to the export */
    }
  }
  return loadJsonlStatus(beadsDir)
}

export async function loadTrains(
  dbPath?: string,
): Promise<Success<Awaited<ReturnType<typeof loadAllTrains>>> | Failure> {
  try {
    const resolved = await workspaceTargetOptions(dbPath)
    const beadsDir = resolved.target?.localBeadsDir ??
      (resolved.dbPath ? beadsDirFromDatabasePath(resolved.dbPath) : null)
    if (!beadsDir) return { success: true, data: [] }
    const data = await loadAllTrains(beadsDir)
    return { success: true, data }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

export async function loadReady(
  dbPath?: string,
): Promise<Success<ReturnType<typeof readyViews>> | Failure> {
  try {
    const { target, options } = await workspaceTargetOptions(dbPath)
    const beadsDir = target?.localBeadsDir ?? (dbPath ? beadsDirFromDatabasePath(dbPath) : null)
    if (!beadsDir) return { success: true, data: [] }
    const trains = await loadAllTrains(beadsDir)
    const status = await loadBeadStatus(beadsDir, options)
    return { success: true, data: readyViews(trains, status) }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

export async function loadCouplers(
  dbPath?: string,
): Promise<
  | Success<
      Array<{
        id: string
        fromTrain: string
        fromCar: string
        toTrain: string
        toCar: string
        mode: string
        note: string
      }>
    >
  | Failure
> {
  try {
    const resolved = await workspaceTargetOptions(dbPath)
    const beadsDir = resolved.target?.localBeadsDir ??
      (resolved.dbPath ? beadsDirFromDatabasePath(resolved.dbPath) : null)
    if (!beadsDir) return { success: true, data: [] }
    const trains = await loadAllTrains(beadsDir)
    const seen = new Set<string>()
    const rows: Array<{
      id: string
      fromTrain: string
      fromCar: string
      toTrain: string
      toCar: string
      mode: string
      note: string
    }> = []
    for (const train of trains) {
      for (const coupler of train.couplers) {
        const key = `${coupler.id}|${coupler.fromTrain}|${coupler.fromCar}|${coupler.toTrain}|${coupler.toCar}|${coupler.mode}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({
          id: coupler.id,
          fromTrain: coupler.fromTrain,
          fromCar: coupler.fromCar,
          toTrain: coupler.toTrain,
          toCar: coupler.toCar,
          mode: coupler.mode,
          note: coupler.note,
        })
      }
    }
    return { success: true, data: rows }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}

/** Cheap presence check: the Trains surface only appears when a workspace has plans. */
export async function hasTrains(dbPath?: string): Promise<Success<boolean> | Failure> {
  try {
    const resolved = await workspaceTargetOptions(dbPath)
    const beadsDir = resolved.target?.localBeadsDir ??
      (resolved.dbPath ? beadsDirFromDatabasePath(resolved.dbPath) : null)
    if (!beadsDir) return { success: true, data: false }
    return { success: true, data: (await listTrainPaths(beadsDir)).length > 0 }
  } catch (error: unknown) {
    return { success: false, error: extractError(error) }
  }
}
