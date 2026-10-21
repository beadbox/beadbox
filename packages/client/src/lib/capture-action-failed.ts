// Source-local copy of lib/capture-action-failed.ts (P3.2 / bb-90zz.2).
// Verbatim — only the relative import for scrub-pii (already relative in source).

import { safeCapture } from "./posthog-safe"
import { scrubPii } from "./scrub-pii"

export function captureServerActionFailed(
  action: string,
  errorMessage: string,
  elapsedMs: number,
): void {
  safeCapture("app_server_action_failed", {
    action,
    error_message: scrubPii(
      errorMessage
        .replace(/\s*\n\s*/g, " ")
        .trim()
        .slice(0, 500),
    ),
    elapsed_ms: elapsedMs,
  })
}

type ActionFailure = { success: false; error: string }

/**
 * Runs a write and turns a rejection into a failed result. rpc calls reject,
 * not return {success:false}, when the sidecar session is destroyed mid-call
 * or the call deadline fires (beadbox-g9xr); without this the caller's failure
 * branch never runs, so an optimistic value and its spinner stay on screen.
 */
export async function settleAction<T extends { success: boolean; error?: string }>(
  fn: () => Promise<T>,
): Promise<T | ActionFailure> {
  try {
    return await fn()
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function trackedAction<T extends { success: boolean; error?: string }>(
  action: string,
  fn: () => Promise<T>,
): Promise<T | ActionFailure> {
  const startMs = Date.now()
  const result = await settleAction(fn)
  if (!result.success) {
    captureServerActionFailed(action, result.error ?? "Unknown error", Date.now() - startMs)
  }
  return result
}
