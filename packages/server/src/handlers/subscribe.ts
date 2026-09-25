// Dual-channel subscription handler. Imperative kkrpc methods (start/stop)
// pair with structured stderr events ([SUBSCRIPTION:<id>] <json>) so the
// client can drive TanStack Query invalidation without HTTP/WS.
//
// Public surface is exactly `start` and `stop` (bead bb-vy13.6 AC).
// Module-scope state and test seams live in ./subscribe-internals.

import { randomUUID } from "node:crypto"

import { createChangeDetector } from "../lib/change-detector"
import type { SubscriptionEvent } from "../subscribe-protocol"
import { emitForSubscription, state } from "./subscribe-internals"

export async function start(workspacePath: string): Promise<{ id: string }> {
  const id = randomUUID()
  const emit = (payload: SubscriptionEvent): void => {
    emitForSubscription(id, payload)
  }
  // bb-xe8g: pass id so the server-mode shell-spawn child can format
  // [SUBSCRIPTION:<id>] lines matching the in-process formatLine emit.
  const detector = await createChangeDetector(workspacePath, emit, id)
  state.detectors.set(id, detector)
  state.paths.set(id, workspacePath)
  return { id }
}

export async function stop(id: string): Promise<void> {
  const detector = state.detectors.get(id)
  state.paths.delete(id)
  if (!detector) return
  state.detectors.delete(id)
  await detector.stop()
}
