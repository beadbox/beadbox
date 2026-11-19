// Dual-channel subscription handler. Imperative kkrpc methods (start/stop)
// pair with structured stderr events ([SUBSCRIPTION:<id>] <json>) so the
// client can drive TanStack Query invalidation without HTTP/WS.
//
// Public surface is exactly `start` and `stop` (bead bb-vy13.6 AC).
// Module-scope state and test seams live in ./subscribe-internals.

import { randomUUID } from "node:crypto"

import { type ChangeDetector, createChangeDetector } from "../lib/change-detector"
import type { SubscriptionEvent } from "../subscribe-protocol"
import { emitForSubscription, state, workspaceKey } from "./subscribe-internals"

// beadbox-0b6: one detector per workspace, and the newest start wins. The
// client holds a single subscription (useChangeSubscription in the root
// route), but a start that missed its deadline on the client still arrives
// here, under an id the client never learns. Kept, each one ran (in server
// mode, a poll child) for the life of the sidecar: four at once after one
// restart. A superseded id is one the client has already abandoned, so
// stopping it later is a no-op.
export async function start(workspacePath: string): Promise<{ id: string }> {
  const id = randomUUID()
  const key = workspaceKey(workspacePath)
  // Taken before the await, so arrival order decides, not creation time.
  const generation = ++state.startSeq
  state.latestStart.set(key, generation)
  const emit = (payload: SubscriptionEvent): void => {
    emitForSubscription(id, payload)
  }
  // bb-xe8g: pass id so the server-mode shell-spawn child can format
  // [SUBSCRIPTION:<id>] lines matching the in-process formatLine emit.
  const detector = await createChangeDetector(workspacePath, emit, id)
  if (state.latestStart.get(key) !== generation) {
    await detector.stop()
    return { id }
  }
  // Swap synchronously, so no other start or stop sees both or neither.
  const replaced: ChangeDetector[] = []
  for (const [oldId, path] of [...state.paths]) {
    if (workspaceKey(path) !== key) continue
    state.paths.delete(oldId)
    const old = state.detectors.get(oldId)
    state.detectors.delete(oldId)
    if (old) replaced.push(old)
  }
  state.detectors.set(id, detector)
  state.paths.set(id, workspacePath)
  for (const old of replaced) await old.stop().catch(() => {})
  return { id }
}

export async function stop(id: string): Promise<void> {
  const detector = state.detectors.get(id)
  state.paths.delete(id)
  if (!detector) return
  state.detectors.delete(id)
  await detector.stop()
}
