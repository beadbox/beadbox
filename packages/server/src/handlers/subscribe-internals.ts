// Test seams for subscribe.ts. Kept in a sibling module so the handler's
// public surface (handlers/subscribe.ts) stays exactly two exports —
// `start` and `stop` — per bead bb-vy13.6 acceptance grep:
//   grep -E "^export" packages/server/src/handlers/subscribe.ts
// must yield exactly those two.
//
// Module-scope state lives here. ES module exports are live bindings, so
// `subscribe.ts` reads `state.writer` at call time and always sees the
// current value, including mutations from _setWriter.

import { createChangeDetector, type ChangeDetector } from "../lib/change-detector"
import { formatLine, type SubscriptionEvent } from "../subscribe-protocol"
import { beadsDirFromDatabasePath } from "../lib/beadtrain-fs"

const defaultWriter = (line: string): void => {
  process.stderr.write(line)
}

export const state = {
  writer: defaultWriter as (line: string) => void,
  detectors: new Map<string, ChangeDetector>(),
  paths: new Map<string, string>(),
}

export function emitForSubscription(id: string, payload: SubscriptionEvent): void {
  state.writer(formatLine(id, payload))
}

/** Keep subscription IDs stable while replacing pollers after an endpoint edit. */
export async function restartWorkspaceSubscriptions(workspacePath: string): Promise<void> {
  const target = beadsDirFromDatabasePath(workspacePath) ?? workspacePath
  const failures: unknown[] = []
  // Snapshot: stop() and start() mutate state.paths while this loop awaits.
  for (const [id, path] of [...state.paths]) {
    if ((beadsDirFromDatabasePath(path) ?? path) !== target) continue
    const detector = state.detectors.get(id)
    if (!detector) continue
    await detector.stop()
    state.detectors.delete(id)
    // stop() may have raced with this restart; do not resurrect a closed subscription.
    if (state.paths.get(id) !== path) continue
    try {
      const fresh = await createChangeDetector(path, (event) => emitForSubscription(id, event), id)
      // stop() can also land while the new detector is being created. It found
      // no detector to stop, so this one must be stopped here or it outlives
      // its subscription (in server mode, a poll child left running).
      if (state.paths.get(id) !== path) {
        await fresh.stop()
        continue
      }
      state.detectors.set(id, fresh)
    } catch (error) {
      state.paths.delete(id)
      emitForSubscription(id, { type: "polling_error" })
      // Keep going: one failed restart must not leave the rest on the old endpoint.
      failures.push(error)
    }
  }
  if (failures.length > 0) throw failures[0]
}

export function _setWriter(fn: (line: string) => void): void {
  state.writer = fn
}

export function _resetWriter(): void {
  state.writer = defaultWriter
}

export function _activeIds(): string[] {
  return Array.from(state.detectors.keys())
}
