// Dual-channel subscription wrapper.
//
// Server side (P1.6): kkrpc subscribe.start(workspacePath) boots a change
// detector and emits events to stderr as `[SUBSCRIPTION:<id>] <json>` lines.
// Client side (this file): on mount, call rpc.subscribe.start(...), capture
// the id, attach an onStderr listener filtered by SUBSCRIPTION_PREFIX, and
// invalidate TanStack Query on each parsed event. On unmount, detach the
// listener and call rpc.subscribe.stop(id).
//
// Smoke-test gotcha (bb-qlf3): not every bd write triggers a subscription
// event — the change detector only polls a curated set of Dolt tables.
// Canonical bd-CLI smoke trigger is `bd update <id> --status open`.
// Full table of which bd writes flip which polled hashes lives in the
// server-side cheat-sheet at packages/server/src/lib/change-detector.ts
// (same comment block also documents the bd orphan-detection silencer).
//
// StrictMode discipline: React 18+ runs effects twice in dev to surface
// missing cleanup. Each mount captures its own id, each cleanup stops THAT
// id — even if mount fires before the previous cleanup completes, the ids
// are distinct so we never leak a subscription. The cancel flag handles
// the race where unmount happens before start resolves.

import {
  parseLine,
  SUBSCRIPTION_PREFIX,
  type SubscriptionEvent,
} from "@beadbox/server/subscribe-protocol"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { useEffect, useState, useSyncExternalStore } from "react"
import { onStderr } from "tauri-plugin-js-api"
import type { WsLifecycleEvent } from "./console-types"
import { getAnalyticsEnabled } from "./local-storage"
import { safeCapture } from "./posthog-safe"
import { queryClient } from "./query-client"
import { isTauriRuntime, rpc } from "./rpc"
import { type BeadboxSubscriptionStamp, ensureBeadboxStamp } from "./window-globals"

const SIDECAR_NAME = "beadbox-sidecar"

/**
 * Test-only seam. Replaces the tauri-plugin-js-api `onStderr` so unit
 * tests can drive the listener synchronously without booting Tauri.
 */
type ListenStderrFn = (name: string, cb: (data: string) => void) => Promise<UnlistenFn>

let listenStderrImpl: ListenStderrFn = onStderr

export function _setListenStderr(fn: ListenStderrFn): void {
  listenStderrImpl = fn
}

export function _resetListenStderr(): void {
  listenStderrImpl = onStderr
}

/**
 * Hook test seam — lets tests pass a custom isTauriRuntime check without
 * mucking with `window.__TAURI_INTERNALS__`. Defaults to the real check.
 */
let runtimeCheck: () => boolean = isTauriRuntime

export function _setRuntimeCheck(fn: () => boolean): void {
  runtimeCheck = fn
}

export function _resetRuntimeCheck(): void {
  runtimeCheck = isTauriRuntime
}

// Module-level subscription change counter + listener set.
//
// Why this exists (bb-hj80): TanStack Query invalidateQueries() only wakes
// up consumers that read via useQuery. P3.3's /activity port kept the
// legacy useEffect+rpc.activity.* fetch pattern (parity discipline) which
// is NOT a useQuery consumer. Without this counter, change events arrive
// at the central subscription but never reach activity-feed/pipeline-flow.
//
// The counter is incremented inside the default applyEvent on every
// `change` event. Components opt in via useSubscriptionChangeSignal(),
// which is React-tear-safe via useSyncExternalStore.
let subscriptionChangeCount = 0
const subscriptionListeners = new Set<() => void>()

function bumpSubscriptionChange(): void {
  subscriptionChangeCount++
  for (const listener of subscriptionListeners) listener()
}

function subscribeChangeListener(listener: () => void): () => void {
  subscriptionListeners.add(listener)
  return () => {
    subscriptionListeners.delete(listener)
  }
}

function getChangeSnapshot(): number {
  return subscriptionChangeCount
}

/**
 * Returns a counter that increments on every `change` event the central
 * useChangeSubscription receives. Consumers that aren't on TanStack Query
 * (legacy useEffect+rpc.* fetch patterns) read this signal as a useEffect
 * dependency to refetch on live bd events.
 *
 * useSyncExternalStore provides tear-free reads under concurrent rendering;
 * the snapshot is a primitive number so identity equality is safe.
 */
export function useSubscriptionChangeSignal(): number {
  return useSyncExternalStore(subscribeChangeListener, getChangeSnapshot, getChangeSnapshot)
}

// bb-x878: subscription chain observability. Mirrors the bb-x0il
// watcher / bb-aurr posthog / bb-1mos update stamp pattern. Operators
// paste `window.__BEADBOX__.subscription` in DevTools and see whether
// the listener is attached, how many events have arrived, when the
// last invalidation fired. NO behavior change — pure side-effect
// stamp, tolerant of non-browser test environments via
// ensureBeadboxStamp returning null.
function getOrInitSubscriptionStamp(): BeadboxSubscriptionStamp | null {
  const root = ensureBeadboxStamp()
  if (!root) return null
  root.subscription ??= {
    activeId: null,
    listenerAttached: false,
    workspacePath: null,
    eventCount: 0,
    lastEventAt: null,
    lastEventType: null,
    lastInvalidateAt: null,
  }
  return root.subscription
}

// bb-ck7j: dev-console subscription tap. Set by home-page/activity-page
// when the dev console mounts; called from applyEvent below so the
// Events tab populates with subscription change/error/recovered lines.
// Null when no dev console is mounted — the emit becomes a no-op.
let _subTap: ((evt: WsLifecycleEvent) => void) | null = null

export function setSubscriptionTap(cb: ((evt: WsLifecycleEvent) => void) | null): void {
  _subTap = cb
}

// bb-jjdw: test-only seam — companion to lib/rpc.ts:_getRpcTap.
export function _getSubscriptionTap(): ((evt: WsLifecycleEvent) => void) | null {
  return _subTap
}

function emitSubscriptionTap(event: SubscriptionEvent): void {
  if (!_subTap) return
  const id = crypto.randomUUID()
  const timestamp = Date.now()
  switch (event.type) {
    case "change":
      _subTap({
        type: "ws_lifecycle",
        id,
        timestamp,
        event: "change_detected",
        detail: event.trigger ?? null,
      })
      return
    case "polling_error":
      _subTap({ type: "ws_lifecycle", id, timestamp, event: "polling_error", detail: null })
      return
    case "reconnecting":
      _subTap({
        type: "ws_lifecycle",
        id,
        timestamp,
        event: "reconnecting",
        detail: `attempt ${event.attempt_number}, backoff ${event.backoff_ms}ms`,
      })
      return
    case "recovered":
      _subTap({ type: "ws_lifecycle", id, timestamp, event: "recovered", detail: null })
      return
    case "bd_command":
      // Multi-agent bd-command relay; not a lifecycle signal — the rpc tap
      // owns the in-app bd-command surface for v0.25 dev console.
      return
  }
}

// bb-v340: WS lifecycle telemetry parity with v0.24.x WebSocket-era event
// names + property shapes (see hooks/use-websocket.ts at git tag v0.24.1).
// Growth dashboards and alerts segment by these event names; preserving
// them verbatim avoids forcing a dashboard rewrite. Server-side polling_error
// + recovered are already transition-gated (errorBroadcasted flag in
// change-detector.ts) so the client doesn't need to dedupe.

// bb-mhh1.2: safeCapture promoted to packages/client/src/lib/posthog-safe.ts
// (shared with all other capture call sites in the renderer). The wrapper
// originated in this file at bb-on9h commit 7f2c467; the contract is
// unchanged — see posthog-safe.ts for the guard rationale + §11.3/§11.4
// citations.

function captureSubscriptionTelemetry(event: SubscriptionEvent): void {
  if (!getAnalyticsEnabled()) return
  switch (event.type) {
    case "polling_error":
      safeCapture("ws_polling_error", { error_type: "unknown" })
      return
    case "reconnecting":
      safeCapture("ws_reconnecting", {
        attempt_number: event.attempt_number,
        backoff_ms: event.backoff_ms,
      })
      return
    case "recovered":
      safeCapture("ws_recovered")
      return
    // change + bd_command are not lifecycle signals.
  }
}

/**
 * Default invalidation policy: any change event invalidates ALL queries
 * AND bumps the subscription change counter (for non-useQuery consumers).
 *
 * P3 routes can refine this per route via TanStack Query's per-query
 * staleTime, but for the first cut the broad invalidate + bump matches
 * the legacy WebSocket "we changed, reload everything" semantics from
 * the legacy ws hook module.
 */
function applyEvent(event: SubscriptionEvent): void {
  emitSubscriptionTap(event)
  captureSubscriptionTelemetry(event)
  // bb-x878: stamp every event regardless of type so DevTools can
  // distinguish "no events at all" from "events arrive but only
  // polling_error type" (the bb-i4qd diagnostic question).
  const stamp = getOrInitSubscriptionStamp()
  if (stamp) {
    stamp.eventCount++
    stamp.lastEventAt = new Date().toISOString()
    stamp.lastEventType = event.type
  }
  if (event.type === "change") {
    queryClient.invalidateQueries()
    bumpSubscriptionChange()
    if (stamp) stamp.lastInvalidateAt = new Date().toISOString()
  }
  // polling_error / reconnecting / recovered / bd_command pass through
  // without invalidation for now; P3 can plug per-route handlers.
}

/** Test-only: read the counter without subscribing. */
export function _getSubscriptionChangeCount(): number {
  return subscriptionChangeCount
}

/**
 * Test-only: deliver a `change` event exactly as the sidecar's subscription
 * would (invalidate queries + bump the counter), without a stderr stream.
 */
export function _emitChangeForTests(): void {
  applyEvent({ type: "change", trigger: "test" } as SubscriptionEvent)
}

/** Test-only: reset to zero between cases. */
export function _resetSubscriptionChangeCount(): void {
  subscriptionChangeCount = 0
  for (const listener of subscriptionListeners) listener()
}

export interface UseChangeSubscriptionOptions {
  /**
   * Override the invalidation behaviour. Useful for tests or for P3 routes
   * that want to scope invalidations to specific query keys.
   */
  onEvent?: (event: SubscriptionEvent) => void
}

/**
 * Subscribes to sidecar change events for `workspacePath`. No-op when:
 *   - workspacePath is null/undefined (workspace not yet selected)
 *   - !isTauriRuntime() (running in browser-only vite dev)
 */
export function useChangeSubscription(
  workspacePath: string | null | undefined,
  options: UseChangeSubscriptionOptions = {},
): void {
  const { onEvent = applyEvent } = options
  const [transportEpoch, setTransportEpoch] = useState(0)

  useEffect(() => {
    if (!runtimeCheck()) return
    const onSidecarExit = () => setTransportEpoch((epoch) => epoch + 1)
    window.addEventListener("beadbox:sidecar-exit", onSidecarExit)
    return () => window.removeEventListener("beadbox:sidecar-exit", onSidecarExit)
  }, [])

  useEffect(() => {
    if (!workspacePath || !runtimeCheck()) return

    let cancelled = false
    let activeId: string | null = null
    let unlisten: UnlistenFn | null = null
    // bb-v340: track whether this mount ever fully connected, and when, so
    // ws_disconnected can carry uptime_ms (matches v0.24.x WebSocket onclose
    // shape). Skipping the capture entirely on never-connected mounts keeps
    // dashboards clean — start-failure has its own ws_disconnected event.
    let connectedAt: number | null = null

    void (async () => {
      try {
        const { id } = await rpc.subscribe.start(workspacePath)
        if (cancelled) {
          // Mount cancelled before start resolved — stop the orphan id so
          // it doesn't outlive the component.
          await rpc.subscribe.stop(id).catch(() => {})
          return
        }
        activeId = id
        // bb-x878: stamp activeId BEFORE attaching listener so DevTools can
        // see "we got an id from start" even if listener attach hangs.
        const startStamp = getOrInitSubscriptionStamp()
        if (startStamp) {
          startStamp.activeId = id
          startStamp.workspacePath = workspacePath
          startStamp.listenerAttached = false
        }

        unlisten = await listenStderrImpl(SIDECAR_NAME, (data) => {
          // tauri-plugin-js typically emits one line per event but split
          // defensively in case a future version batches.
          for (const line of data.split("\n")) {
            if (!line.startsWith(SUBSCRIPTION_PREFIX)) continue
            const parsed = parseLine(line + (line.endsWith("\n") ? "" : "\n"))
            if (!parsed) continue
            // Filter to events for OUR subscription id — multiple subscriptions
            // could share the stderr stream if a future bead allows it.
            if (parsed.id !== id) continue
            onEvent(parsed.payload)
          }
        })

        if (cancelled) {
          // Unmount happened between start and listen attach — clean up
          // both ends.
          unlisten?.()
          await rpc.subscribe.stop(id).catch(() => {})
        } else {
          // bb-x878: listener attach succeeded and we're still mounted.
          const attachedStamp = getOrInitSubscriptionStamp()
          if (attachedStamp) attachedStamp.listenerAttached = true
          // bb-v340: full subscription up — fire ws_connected. reconnect:false
          // because the post-bb-xe8g pipeline has no client-side auto-reconnect;
          // each mount is a fresh subscription (workspace switch or app start),
          // not a retry of a dropped connection.
          connectedAt = Date.now()
          if (transportEpoch > 0) {
            onEvent({ type: "change", timestamp: connectedAt, trigger: "sidecar-reconnected" })
          }
          if (getAnalyticsEnabled()) {
            safeCapture("ws_connected", { reconnect: false })
          }
        }
      } catch (err) {
        // Subscription failed. Log via console.warn (browser console) so
        // dev sessions surface the issue without crashing the SPA.
        // eslint-disable-next-line no-console
        console.warn("[useChangeSubscription] start failed:", err)
        // bb-v340: start-failure ws_disconnected. was_clean:false because
        // the subscription never got off the ground; reason carries the
        // error message for debugging without leaking PII (rpc errors are
        // structural — "transport closed", "method not found", etc.).
        if (!cancelled && getAnalyticsEnabled()) {
          safeCapture("ws_disconnected", {
            reason: err instanceof Error ? err.message : String(err),
            was_clean: false,
          })
        }
      }
    })()

    return () => {
      cancelled = true
      const idAtCleanup = activeId
      const unlistenAtCleanup = unlisten
      const connectedAtCleanup = connectedAt
      activeId = null
      unlisten = null
      connectedAt = null
      try {
        unlistenAtCleanup?.()
      } catch {
        /* tolerable during teardown */
      }
      if (idAtCleanup != null) {
        void rpc.subscribe.stop(idAtCleanup).catch(() => {})
      }
      // bb-v340: only fire ws_disconnected on cleanup if we ever actually
      // connected — never-connected mounts already emitted the failure
      // event in the catch branch. was_clean:true because cleanup is the
      // graceful-teardown path (unmount, workspace switch).
      if (connectedAtCleanup != null && getAnalyticsEnabled()) {
        safeCapture("ws_disconnected", {
          was_clean: true,
          uptime_ms: Date.now() - connectedAtCleanup,
        })
      }
      // bb-x878: clear listener flag + activeId on teardown so DevTools
      // shows the post-unmount state. Preserve eventCount/lastEventAt
      // so post-mortem after teardown still has the historical record.
      const teardownStamp = getOrInitSubscriptionStamp()
      if (teardownStamp) {
        teardownStamp.activeId = null
        teardownStamp.listenerAttached = false
        teardownStamp.workspacePath = null
      }
    }
  }, [workspacePath, onEvent, transportEpoch])
}
