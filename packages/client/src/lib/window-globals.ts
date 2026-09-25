// Canonical `window.__BEADBOX__` diagnostic-stamp namespace (bb-j04q).
//
// All DevTools-inspectable state lives under `window.__BEADBOX__.*` so an
// operator triaging a running app can hit one name to see everything:
//
//   await window.__BEADBOX__         // full snapshot
//   window.__BEADBOX__.posthog       // bb-aurr telemetry init state
//   window.__BEADBOX__.update        // bb-1mos last update-check outcome
//   window.__BEADBOX__.watcher       // bb-x0il sidecar parent-death watcher
//   window.__BEADBOX__.shutdown      // bb-0vlu sidecar shutdown trail
//   window.__BEADBOX__.db            // active workspace database path
//
// Stamp modules read/write their slot via `(window.__BEADBOX__ ??= {}).x = …`
// — the `??=` makes the namespace safe to populate from any boot order.
//
// `window.bd` lives at the top level (not under __BEADBOX__) intentionally:
// it's an INTERACTIVE helper for typing in DevTools (`await bd("show", "bb-…")`)
// where muscle memory is the whole point. The other entries are PROGRAMMATIC
// diagnostics nobody types by hand.

export interface BeadboxPosthogStamp {
  key_present: boolean
  host: string
  host_from_env: string | undefined
  init: boolean | string
}

export type BeadboxUpdateOutcome =
  | "ok_update_available"
  | "ok_no_update_same_version"
  | "ok_no_update_older_remote"
  | "suppressed_promoted_rc"
  | "no_artifact_for_platform"
  | "no_platform_detected"
  | "release_payload_empty"
  | "release_filtered_out"
  | "fetch_failed"
  | "checker_threw"

export interface BeadboxUpdateStamp {
  lastCheckedAt: string
  outcome: BeadboxUpdateOutcome
  repo: string
  includePrerelease: boolean
  currentVersion: string
  buildTag: string | undefined
  remoteVersion: string | null
  artifactName: string | null
}

export type BeadboxWatcherStatus =
  | "watcher_spawned"
  | "watcher_skipped"
  | "watcher_spawn_failed"
  | "unknown"

export interface BeadboxWatcherStamp {
  observedAt: string
  status: BeadboxWatcherStatus
  shellPid: number | null
  parentPid: number | null
  mainPid: number | null
  intervalSec: number | null
  signal: "KILL" | "TERM" | null
  reason: string | null
  raw: string
}

export interface BeadboxShutdownStamp {
  observedAt: string
  signal: string | null
  pid: number | null
  ppid: number | null
  parentChain: string | null
  beadboxProcs: string | null
  watchdogEscalated: boolean
  raw: string
}

// bb-x878: subscription chain observability for bb-i4qd-class triage.
// `lib/subscribe.ts` writes this slot from useChangeSubscription's start
// success path, applyEvent, and cleanup. Operators paste
// `window.__BEADBOX__.subscription` in DevTools and see whether the
// listener is attached, how many events have arrived, and when the last
// invalidation fired.
export type BeadboxSubscriptionEventType =
  | "change"
  | "polling_error"
  | "reconnecting"
  | "recovered"
  | "heartbeat"
  | "bd_command"

export interface BeadboxSubscriptionStamp {
  activeId: string | null
  listenerAttached: boolean
  workspacePath: string | null
  eventCount: number
  lastEventAt: string | null
  lastEventType: BeadboxSubscriptionEventType | null
  lastInvalidateAt: string | null
}

// beadbox-jk7 / cascade-9 diagnostic: ring-buffer of loadEpics lifecycle
// transitions so an operator can see, post-hoc, whether each subscription
// event reached loadEpics and what happened (resolved + setEpics, discarded
// by stale-gen, threw). Trimmed to the last 32 entries to keep the JSON.stringify
// snapshot manageable when pasted from DevTools.
export type BeadboxLoadEpicsPhase = "start" | "resolved" | "stale" | "error"

export interface BeadboxLoadEpicsEntry {
  ts: string
  phase: BeadboxLoadEpicsPhase
  gen: number
  dbPath: string | null
  epicsLength?: number
  errorMessage?: string
}

export interface BeadboxStamp {
  db?: string
  posthog?: BeadboxPosthogStamp
  update?: BeadboxUpdateStamp
  watcher?: BeadboxWatcherStamp
  shutdown?: BeadboxShutdownStamp
  subscription?: BeadboxSubscriptionStamp
  loadEpics?: BeadboxLoadEpicsEntry[]
}

declare global {
  interface Window {
    __BEADBOX__?: BeadboxStamp
    bd?: (...args: string[]) => Promise<string>
  }
}

/**
 * Get-or-init the canonical `window.__BEADBOX__` stamp object.
 *
 * Returns the same object on every call. Use:
 *   const stamp = ensureBeadboxStamp()
 *   if (stamp) stamp.update = { ... }
 *
 * Returns null in non-browser environments (SSR / Node tests). Splitting the
 * init from the field write keeps each stamp site clear of assignment-in-
 * expression patterns that biome's `noAssignInExpressions` rule flags.
 */
export function ensureBeadboxStamp(): BeadboxStamp | null {
  if (typeof window === "undefined") return null
  window.__BEADBOX__ ??= {}
  return window.__BEADBOX__
}
