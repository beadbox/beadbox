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
import { workspaceTargetOptions } from "./workspace-target-options"

export async function start(workspaceIdOrPath: string): Promise<{ id: string }> {
  const { target, dbPath } = await workspaceTargetOptions(workspaceIdOrPath)
  if (!dbPath) throw new Error("Workspace is required for subscription")
  const id = randomUUID()
  const emit = (payload: SubscriptionEvent): void => {
    emitForSubscription(id, payload)
  }
  const detector = await createChangeDetector(dbPath, emit, id, target?.id)
  state.detectors.set(id, detector)
  state.paths.set(id, dbPath)
  if (target) state.workspaceIds.set(id, target.id)
  return { id }
}

export async function stop(id: string): Promise<void> {
  const detector = state.detectors.get(id)
  state.paths.delete(id)
  state.workspaceIds.delete(id)
  if (!detector) return
  state.detectors.delete(id)
  await detector.stop()
}
