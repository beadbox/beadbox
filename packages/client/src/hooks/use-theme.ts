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

  // Bumped when the sidecar process restarts (lib/rpc.ts's
  // "beadbox:sidecar-exit" window event — mirrors lib/subscribe.ts's own
  // transportEpoch). A restarted process boots a fresh
  // packages/server/src/handlers/themes.ts module, so its stopWatcher is
  // null again and nothing is watching the themes folder until
  // rpc.themes.startWatch() runs against the NEW process. This hook's own
  // stderr listener survives the restart untouched (it is keyed by sidecar
  // name, not process), so without re-running the watcher effect below on
  // this bump, hot reload would go silently dead for the rest of the
  // session.
  const [transportEpoch, setTransportEpoch] = useState(0)

  useEffect(() => {
    if (!runtimeCheck()) return
    const onSidecarExit = () => setTransportEpoch((epoch) => epoch + 1)
    window.addEventListener("beadbox:sidecar-exit", onSidecarExit)
    return () => window.removeEventListener("beadbox:sidecar-exit", onSidecarExit)
  }, [])

  // themeId can change (user switches theme) without the watcher effect
  // below re-subscribing; the listener closure reads this ref instead of
  // depending on themeId directly, so the stderr listener and the
  // startWatch/stopWatch RPC pair aren't torn down and rebuilt on every
  // switch.
  const themeIdRef = useRef(themeId)
  useEffect(() => {
    themeIdRef.current = themeId
  }, [themeId])

  // Tells apart a hot-reload re-apply (reapplyEpoch bumped, themeId
  // unchanged since this effect's previous run) from the initial apply and
  // from a user-driven theme switch (themeId changed). Explicit refs rather
  // than inferring it from reapplyEpoch's value alone: reapplyEpoch can
  // already be > 0 by the time a later themeId switch reruns this effect,
  // so "epoch > 0" alone would misclassify that switch as a hot-reload
  // re-apply too.
  const lastAppliedThemeIdRef = useRef<string | null>(null)
  const lastReapplyEpochRef = useRef(reapplyEpoch)

  useEffect(() => {
    if (!available) return
    // Only a hot-reload re-apply (same themeId as the previous run, with
    // reapplyEpoch — and nothing else — having changed) sets this true. The
    // initial apply (lastAppliedThemeIdRef.current starts null) and a
    // themeId switch both leave it false.
    const isHotReloadReapply =
      lastAppliedThemeIdRef.current === themeId && reapplyEpoch !== lastReapplyEpochRef.current
    lastAppliedThemeIdRef.current = themeId
    lastReapplyEpochRef.current = reapplyEpoch

    let cancelled = false
    void loadTheme(themeId).then((theme) => {
      if (cancelled) return
      // On the hot-reload path there IS a last-good theme already on
      // screen, so a load that resolves to a DIFFERENT id — loadTheme
      // collapsing a second, now-invalid save to FALLBACK_THEME — must be
      // refused rather than applied: applying it would strand the app on
      // Beadbox Dark until the file becomes valid again (task-13-addendum),
      // exactly what "fall back to the last good theme" forbids. The
      // initial apply and a themeId switch have no last-good theme to
      // protect, so loadTheme's fallback there is correct and must still go
      // through — note loadTheme short-circuits built-in ids, so when the
      // active theme IS the dark built-in, theme.id legitimately equals
      // themeId and this guard correctly does not trigger.
      if (isHotReloadReapply && theme.id !== themeId) return
      applyTheme(theme)
    })
    return () => {
      cancelled = true
    }
  }, [themeId, available, reapplyEpoch])

  // biome-ignore lint/correctness/useExhaustiveDependencies: transportEpoch is a deliberate re-run trigger (re-subscribe against a restarted sidecar) and is not read in the body
  useEffect(() => {
    if (!available) return
    if (!runtimeCheck()) return // browser/stub mode: no sidecar, hot reload is simply absent
    let disposed = false
    let unlisten: UnlistenFn | null = null

    void rpc.themes.startWatch().catch(() => {})

    void (async () => {
      try {
        const stop = await listenStderrImpl(SIDECAR_NAME, (data) => {
          if (disposed) return
          for (const line of data.split("\n")) {
            if (!line.startsWith(THEMES_CHANGED_PREFIX)) continue
            // The invalidate must run BEFORE the fetchQuery: query-client.ts
            // sets a global staleTime of 30s, so the synchronous invalidate
            // is what marks themesQueryKey stale. Without it running first,
            // fetchQuery would just serve the cached (up to 30s stale)
            // entries instead of re-reading the directory — swapping this
            // order silently breaks hot reload. This invalidation is also
            // the error-reporting channel: it is what makes
            // settings-dialog.tsx's picker show (or clear) a rejection
            // reason per ThemeEntry.error, not merely a nice-to-have
            // refresh.
            void queryClient.invalidateQueries({ queryKey: themesQueryKey })
            void queryClient
              .fetchQuery({ queryKey: themesQueryKey, queryFn: listThemes })
              .then((entries) => {
                if (disposed) return
                const entry = entries.find((e) => e.id === themeIdRef.current)
                // A MISSING entry (file deleted) is not "still valid" — an
                // absent `.find()` result is `undefined`, and `!undefined`
                // is true, so this must be spelled out rather than negating
                // `entry?.error` alone, or a deleted active theme's file
                // would read as valid and bump the epoch, sending a deleted
                // theme's id into loadTheme/rpc.themes.get, which would
                // collapse to FALLBACK_THEME anyway — just via a path that
                // looks like "still valid" instead of an intentional one.
                const stillValid = entry !== undefined && !entry.error
                if (stillValid) setReapplyEpoch((n) => n + 1)
                // else: leave the applied theme as-is; the failure reason
                // (or the file's absence from the list) is already visible
                // via the invalidated list above.
              })
              .catch(() => {
                /* list refresh failed; leave the currently applied theme as-is */
              })
          }
        })
        if (disposed) {
          // Cleanup already ran before this promise resolved — this
          // effect's own cleanup saw `unlisten` as still null and skipped
          // it (the same race lib/subscribe.ts:419-420/466 guards against:
          // React 18 StrictMode double-invokes effects in dev, and
          // main.tsx wraps the app in <StrictMode>), so unlisten the real
          // listener here instead of leaking it.
          stop()
        } else {
          unlisten = stop
        }
      } catch {
        /* listener attach failed — hot reload is simply absent this session */
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
      void rpc.themes.stopWatch().catch(() => {})
    }
  }, [available, queryClient, transportEpoch])

  return { themeId, setTheme, available }
}
