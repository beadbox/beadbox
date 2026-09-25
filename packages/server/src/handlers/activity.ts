// Activity sidecar handlers — kkrpc port of actions/activity.ts.
//
// Parity contract: every export here mirrors the corresponding export in
// actions/activity.ts (same name, same signature, same return shape). The
// old server actions remain in place; the parity runner in P1.7 diffs the
// two side-by-side. P3 rewires the app to call these handlers.
//
// Channel discipline: all errors are caught and folded into the structured
// return value. Throwing across the kkrpc boundary would emit a generic
// error frame and lose the message detail the dev console + activity feed
// rely on.

import { type BdBead, listActivity, listBeads } from "../lib/bd"
import type { ActivityEvent } from "../lib/types"
import { workspaceTargetOptions } from "./workspace-target-options"

export async function getActivityEvents(
  dbPath?: string,
  limit: number = 100,
): Promise<{ events: ActivityEvent[]; error?: string }> {
  try {
    const { options } = await workspaceTargetOptions(dbPath)
    const events = await listActivity(options, limit)
    return { events }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load activity"
    return { events: [], error: message }
  }
}

export async function listBeadsByStatus(
  dbPath?: string,
): Promise<{ beads: BdBead[]; error?: string }> {
  try {
    const { options } = await workspaceTargetOptions(dbPath)
    const beads = await listBeads(options)
    return { beads }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load beads"
    return { beads: [], error: message }
  }
}

export async function getActivityEventsSince(
  dbPath: string,
  since: string,
  limit: number = 100,
): Promise<{ events: ActivityEvent[]; error?: string }> {
  try {
    const { options } = await workspaceTargetOptions(dbPath)
    const events = await listActivity(options, limit, since)
    return { events }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load activity"
    return { events: [], error: message }
  }
}
