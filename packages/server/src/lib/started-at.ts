// metadata.started_at: when work on a bead began. bd keeps no such field, so
// Beadbox records it the first time it sees a bead in a started status. The
// Chart view reads it as the start of a bead's bar (beadbox-eic).

import { type BdOptions, updateMetadata } from "./bd"
import type { Bead, Epic } from "./types"

export const STARTED_AT_KEY = "started_at"

// Every status outside this set counts as started, custom statuses included.
const NOT_STARTED = new Set(["open", "deferred", "blocked", "closed"])

// Beads in a started status that have no started_at yet, each listed once.
export function beadsNeedingStartedAt(epics: Epic[]): Bead[] {
  const found = new Map<string, Bead>()
  const visit = (bead: Bead) => {
    if (!NOT_STARTED.has(bead.status) && !bead.metadata?.[STARTED_AT_KEY] && !found.has(bead.id)) {
      found.set(bead.id, bead)
    }
    bead.children?.forEach(visit)
    ;(bead as Epic).childEpics?.forEach(visit)
  }
  epics.forEach(visit)
  return [...found.values()]
}

// Per database: writes still running, and beads whose write failed this
// session (not retried, so a read-only replica cannot cause a write loop).
const inFlight = new Map<string, Set<string>>()
const failed = new Map<string, Set<string>>()

function setFor(map: Map<string, Set<string>>, dbKey: string): Set<string> {
  let set = map.get(dbKey)
  if (!set) {
    set = new Set()
    map.set(dbKey, set)
  }
  return set
}

// Patches started_at into the given tree (so this reply is already right) and
// writes it to bd in the background, one bead after another. The value is the
// bead's updated_at: when the status change was its last edit, that is the
// moment work started, however long ago Beadbox last looked. Only missing keys
// are written, so a reopened bead keeps its first start. The returned promise
// settles when the writes are done; callers on the load path do not await it.
export function recordStartedAt(epics: Epic[], options: BdOptions): Promise<void> {
  const dbKey = options.db ?? ""
  const running = setFor(inFlight, dbKey)
  const failedHere = setFor(failed, dbKey)
  const writes: Array<[string, string]> = []
  for (const bead of beadsNeedingStartedAt(epics)) {
    if (!bead.updatedAt || failedHere.has(bead.id)) continue
    const value = bead.updatedAt.toISOString()
    bead.metadata = { ...bead.metadata, [STARTED_AT_KEY]: value }
    if (running.has(bead.id)) continue
    running.add(bead.id)
    writes.push([bead.id, value])
  }
  if (writes.length === 0) return Promise.resolve()
  return (async () => {
    for (const [id, value] of writes) {
      try {
        await updateMetadata(id, STARTED_AT_KEY, value, options)
      } catch (error) {
        failedHere.add(id)
        console.error(`[started-at] could not record ${STARTED_AT_KEY} for ${id}: ${String(error)}`)
      } finally {
        running.delete(id)
      }
    }
  })()
}

/** @internal tests only */
export function __resetStartedAtState(): void {
  inFlight.clear()
  failed.clear()
}
