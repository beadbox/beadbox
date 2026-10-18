// bb-x0il: DevTools-inspectable diagnostic stamp for the sidecar's
// parent-death watcher. Mirrors bb-1mos's __BEADBOX__.update pattern.
//
// The sidecar (packages/server/src/lib/parent-death-watcher.ts) emits
// `[bb-x0il-state]` stderr lines on watcher init. tauri-plugin-js relays
// sidecar stderr to the frontend as `js-process-stderr` events; this
// module subscribes early in app boot, parses those lines, and writes
// the parsed state to `window.__BEADBOX__.watcher` so an ops engineer
// with the app open + DevTools can answer "is the watcher alive, what
// parent PID is it watching, what shell PID is doing the poll?" without
// re-running the orphan-kill smoke.

import type { UnlistenFn } from "@tauri-apps/api/event"
import { isTauriRuntime } from "./rpc"
import { onStderr } from "./sidecar-transport"
import type { BeadboxWatcherStamp, BeadboxWatcherStatus } from "./window-globals"
import { ensureBeadboxStamp } from "./window-globals"

const SIDECAR_NAME = "beadbox-sidecar"
const STAMP_PREFIX = "[bb-x0il-state]"

type WatcherStatus = BeadboxWatcherStatus

type ListenStderrFn = (name: string, cb: (data: string) => void) => Promise<UnlistenFn>

let listenStderrImpl: ListenStderrFn = onStderr

export function _setListenStderrForStamp(fn: ListenStderrFn): void {
  listenStderrImpl = fn
}

export function _resetListenStderrForStamp(): void {
  listenStderrImpl = onStderr
}

let runtimeCheck: () => boolean = isTauriRuntime

export function _setRuntimeCheckForStamp(fn: () => boolean): void {
  runtimeCheck = fn
}

export function _resetRuntimeCheckForStamp(): void {
  runtimeCheck = isTauriRuntime
}

function parseStateLine(line: string): BeadboxWatcherStamp | null {
  if (!line.startsWith(STAMP_PREFIX)) return null
  const body = line.slice(STAMP_PREFIX.length).trim()
  // Expected shape: "watcher_spawned shellPid=N parentPid=N mainPid=N intervalSec=N signal=KILL"
  // or: "watcher_skipped reason=parent_pid_1 mainPid=N"
  // or: "watcher_spawn_failed parentPid=N mainPid=N err=..."
  const parts = body.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  const status = parts[0] as WatcherStatus
  const kv: Record<string, string> = {}
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    kv[part.slice(0, eq)] = part.slice(eq + 1)
  }
  const num = (k: string): number | null => {
    const v = kv[k]
    if (v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const sig = kv.signal === "KILL" || kv.signal === "TERM" ? kv.signal : null
  const isKnown =
    status === "watcher_spawned" ||
    status === "watcher_skipped" ||
    status === "watcher_spawn_failed"
  return {
    observedAt: new Date().toISOString(),
    status: isKnown ? status : "unknown",
    shellPid: num("shellPid"),
    parentPid: num("parentPid"),
    mainPid: num("mainPid"),
    intervalSec: num("intervalSec"),
    signal: sig,
    reason: kv.reason ?? null,
    raw: line,
  }
}

/**
 * Subscribes to the sidecar's stderr stream and stamps watcher state
 * onto `window.__BEADBOX__.watcher` on every `[bb-x0il-state]` line.
 * Returns a teardown function (mostly for tests; production keeps the
 * listener for the lifetime of the app).
 *
 * Outside Tauri runtime (browser dev, Playwright, vitest) this is a
 * no-op — there is no sidecar to listen to.
 */
export function startSidecarWatcherStamp(): () => void {
  if (typeof window === "undefined") return () => {}
  if (!runtimeCheck()) return () => {}

  let unlisten: UnlistenFn | undefined
  let cancelled = false

  void (async () => {
    try {
      const cb = (data: string) => {
        const beadbox = ensureBeadboxStamp()
        if (!beadbox) return
        for (const line of data.split("\n")) {
          const parsed = parseStateLine(line)
          if (!parsed) continue
          beadbox.watcher = parsed
        }
      }
      unlisten = await listenStderrImpl(SIDECAR_NAME, cb)
      if (cancelled) {
        unlisten?.()
      }
    } catch {
      /* listener attach failed — non-fatal; the SPA continues */
    }
  })()

  return () => {
    cancelled = true
    unlisten?.()
  }
}

// Test-only export: the parser is pure, useful for asserting shape
// without spinning up the listener.
export const _parseStateLineForTests = parseStateLine
