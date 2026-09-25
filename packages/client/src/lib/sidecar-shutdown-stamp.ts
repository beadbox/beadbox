// bb-0vlu: DevTools-inspectable diagnostic stamp for sidecar shutdown
// events. Sibling of bb-x0il's sidecar-watcher-stamp.ts.
//
// The sidecar (packages/server/src/index.ts) emits two structured stderr
// lines on shutdown:
//   [bb-0vlu] sigterm_received signal=SIGTERM pid=N ppid=N
//             parentChain="<pid ppid name lines>" beadboxProcs="<pid ppid name lines>"
//   (processes by pid and executable name only, never argv or env: beadbox-9j1)
//   [bb-0vlu] shutdown_watchdog_escalating — process.exit hung past 2s, SIGKILL self
//
// This module subscribes to tauri-plugin-js's onStderr early in app boot,
// parses those lines, and writes the latest state to
// window.__BEADBOX__.shutdown.
//
// Operator usage: when triaging a stuck-shutdown report, open DevTools on
// a running Beadbox.app and inspect window.__BEADBOX__.shutdown. The
// parentChain + beadboxProcs fields capture the process landscape at the
// moment the rogue SIGTERM hit — typically enough to identify the sender
// (tauri-plugin-js helper, an intermediate shell, etc.).

import type { UnlistenFn } from "@tauri-apps/api/event"
import { onStderr } from "tauri-plugin-js-api"
import { isTauriRuntime } from "./rpc"
import { ensureBeadboxStamp } from "./window-globals"

const SIDECAR_NAME = "beadbox-sidecar"
const STAMP_PREFIX = "[bb-0vlu]"

type ListenStderrFn = (name: string, cb: (data: string) => void) => Promise<UnlistenFn>

let listenStderrImpl: ListenStderrFn = onStderr

export function _setListenStderrForShutdownStamp(fn: ListenStderrFn): void {
  listenStderrImpl = fn
}

export function _resetListenStderrForShutdownStamp(): void {
  listenStderrImpl = onStderr
}

let runtimeCheck: () => boolean = isTauriRuntime

export function _setRuntimeCheckForShutdownStamp(fn: () => boolean): void {
  runtimeCheck = fn
}

export function _resetRuntimeCheckForShutdownStamp(): void {
  runtimeCheck = isTauriRuntime
}

/**
 * Extract a key=value or key="quoted value with spaces" field from a
 * single bb-0vlu line body. Returns null if the key isn't present.
 *
 * The ps/pgrep outputs are JSON.stringify'd by the sidecar so they're
 * always quoted strings — we re-parse the JSON to get the raw multi-line
 * text back. Numeric fields like pid/ppid are bare integers.
 */
function extractField(body: string, key: string): string | null {
  // Quoted form: key="..."
  const quoted = body.match(new RegExp(`\\b${key}=("(?:[^"\\\\]|\\\\.)*")`))
  if (quoted) {
    try {
      return JSON.parse(quoted[1])
    } catch {
      return quoted[1].slice(1, -1)
    }
  }
  // Bare form: key=token (token = non-whitespace until next field)
  const bare = body.match(new RegExp(`\\b${key}=(\\S+)`))
  return bare ? bare[1] : null
}

function parseNumberField(body: string, key: string): number | null {
  const raw = extractField(body, key)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export interface ShutdownStamp {
  observedAt: string
  signal: string | null
  pid: number | null
  ppid: number | null
  parentChain: string | null
  beadboxProcs: string | null
  watchdogEscalated: boolean
  raw: string
}

export function _parseShutdownLineForTests(
  line: string,
  prev?: ShutdownStamp,
): ShutdownStamp | null {
  if (!line.startsWith(STAMP_PREFIX)) return null
  const body = line.slice(STAMP_PREFIX.length).trim()
  if (body.startsWith("sigterm_received")) {
    return {
      observedAt: new Date().toISOString(),
      signal: extractField(body, "signal"),
      pid: parseNumberField(body, "pid"),
      ppid: parseNumberField(body, "ppid"),
      parentChain: extractField(body, "parentChain"),
      beadboxProcs: extractField(body, "beadboxProcs"),
      watchdogEscalated: false,
      raw: line,
    }
  }
  if (body.startsWith("shutdown_watchdog_escalating")) {
    // Augment the last sigterm_received stamp instead of replacing it —
    // the operator wants both pieces of information together.
    const base = prev ?? {
      observedAt: new Date().toISOString(),
      signal: null,
      pid: null,
      ppid: null,
      parentChain: null,
      beadboxProcs: null,
      watchdogEscalated: false,
      raw: "",
    }
    return {
      ...base,
      observedAt: new Date().toISOString(),
      watchdogEscalated: true,
      raw: prev ? `${prev.raw}\n${line}` : line,
    }
  }
  return null
}

/**
 * Subscribes to sidecar stderr and stamps shutdown events onto
 * window.__BEADBOX__.shutdown. No-op outside Tauri runtime.
 * Returns a teardown function (mostly for tests).
 */
export function startSidecarShutdownStamp(): () => void {
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
          const next = _parseShutdownLineForTests(line, beadbox.shutdown)
          if (!next) continue
          beadbox.shutdown = next
        }
      }
      unlisten = await listenStderrImpl(SIDECAR_NAME, cb)
      if (cancelled) {
        unlisten?.()
      }
    } catch {
      /* listener attach failed — non-fatal */
    }
  })()

  return () => {
    cancelled = true
    unlisten?.()
  }
}
