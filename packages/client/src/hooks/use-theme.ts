// Owns the active theme for the session: reads the stored preference,
// loads the theme, applies it, and persists changes.
//
// If the startup probe says token indirection does not resolve on this
// engine, nothing is applied and the app renders from index.css's baked
// :root literals — today's appearance. `available` is false so the picker
// can explain why switching is unavailable instead of silently doing
// nothing.
//
// The preference id itself is NOT local state here: it comes from
// use-theme-preference.ts, which subscribes to local-storage.ts's single
// store via useSyncExternalStore, so this hook, usePreferences, and any
// other consumer all read the same single store. A change made through
// any one of them (e.g. the settings dialog) re-renders every subscriber,
// including this one — see
// .superpowers/sdd/2026-11-13-runtime-themes/task-11-addendum.md for why a
// local useState here would silently stop the applied theme from tracking
// changes made elsewhere.

import { useQueryClient } from "@tanstack/react-query"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { useEffect, useRef, useState } from "react"

import { rpc } from "../lib/rpc"
import { hasSidecarTransport, onStderr } from "../lib/sidecar-transport"
import { applyTheme, isThemingAvailable } from "../lib/theme-engine"
import { listThemes, loadTheme, themesQueryKey } from "../lib/theme-source"
import { useThemePreference } from "./use-theme-preference"

// Task 13 hot reload: the sidecar's themes.startWatch() emits this line on
// stderr (packages/server/src/handlers/themes.ts) whenever a file in the
// themes directory changes. Same stderr channel lib/subscribe.ts's
// [SUBSCRIPTION:<id>] stream uses — no new transport, just a different
// line prefix to filter on.
const SIDECAR_NAME = "beadbox-sidecar"
const THEMES_CHANGED_PREFIX = "[THEMES:changed]"

type ListenStderrFn = (name: string, cb: (data: string) => void) => Promise<UnlistenFn>

// Test seams, mirroring the pattern lib/subscribe.ts and
// lib/sidecar-watcher-stamp.ts use for their own independent stderr
// listeners: module-level indirection a test can swap out, since bun:test
// has no vitest-style module mocking.
let listenStderrImpl: ListenStderrFn = onStderr
export function _setListenStderrForTheme(fn: ListenStderrFn): void {
  listenStderrImpl = fn
}
export function _resetListenStderrForTheme(): void {
  listenStderrImpl = onStderr
}

let runtimeCheck: () => boolean = hasSidecarTransport
export function _setRuntimeCheckForTheme(fn: () => boolean): void {
  runtimeCheck = fn
}
export function _resetRuntimeCheckForTheme(): void {
  runtimeCheck = hasSidecarTransport
}

export function useTheme(): {
  themeId: string
  setTheme: (id: string) => void
  available: boolean
} {
  const { themeId, setTheme } = useThemePreference()
  // Lazy-once: the probe is memoised in theme-engine.ts and must not run per render.
  const [available] = useState(() => isThemingAvailable())
  const queryClient = useQueryClient()

  // Bumped only when a hot-reload revalidation finds the ACTIVE theme still
  // valid, so the apply effect below re-runs and re-reads the same id. A
  // revalidation that FAILS does not bump this: per task-13-addendum, the
  // currently applied theme must stay on screen rather than snapping to
  // FALLBACK_THEME (which loadTheme collapses failures to — correct for
  // startup, where there is no "last good" theme yet, but wrong here).
  const [reapplyEpoch, setReapplyEpoch] = useState(0)

  // themeId can change (user switches theme) without the watcher effect
  // below re-subscribing; the listener closure reads this ref instead of
  // depending on themeId directly, so the stderr listener and the
  // startWatch/stopWatch RPC pair aren't torn down and rebuilt on every
  // switch.
  const themeIdRef = useRef(themeId)
  useEffect(() => {
    themeIdRef.current = themeId
  }, [themeId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reapplyEpoch is a deliberate re-run trigger (hot reload re-applying the same themeId) and is not read in the body
  useEffect(() => {
    if (!available) return
    let cancelled = false
    void loadTheme(themeId).then((theme) => {
      if (!cancelled) applyTheme(theme)
    })
    return () => {
      cancelled = true
    }
  }, [themeId, available, reapplyEpoch])

  useEffect(() => {
    if (!available) return
    if (!runtimeCheck()) return // browser/stub mode: no sidecar, hot reload is simply absent
    let disposed = false
    let unlisten: UnlistenFn | null = null

    void rpc.themes.startWatch().catch(() => {})

    void (async () => {
      try {
        unlisten = await listenStderrImpl(SIDECAR_NAME, (data) => {
          if (disposed) return
          for (const line of data.split("\n")) {
            if (!line.startsWith(THEMES_CHANGED_PREFIX)) continue
            // This invalidation is the error-reporting channel: it is what
            // makes settings-dialog.tsx's picker show (or clear) a
            // rejection reason per ThemeEntry.error, not merely a
            // nice-to-have refresh.
            void queryClient.invalidateQueries({ queryKey: themesQueryKey })
            void queryClient
              .fetchQuery({ queryKey: themesQueryKey, queryFn: listThemes })
              .then((entries) => {
                if (disposed) return
                const stillValid = !entries.find((e) => e.id === themeIdRef.current)?.error
                if (stillValid) setReapplyEpoch((n) => n + 1)
                // else: leave the applied theme as-is; the failure reason
                // is already visible via the invalidated list above.
              })
              .catch(() => {
                /* list refresh failed; leave the currently applied theme as-is */
              })
          }
        })
      } catch {
        /* listener attach failed — hot reload is simply absent this session */
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
      void rpc.themes.stopWatch().catch(() => {})
    }
  }, [available, queryClient])

  return { themeId, setTheme, available }
}
