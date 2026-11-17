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

import type { Appearance } from "@beadbox/server/theme-tokens"
import { useQueryClient } from "@tanstack/react-query"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { useEffect, useRef, useState } from "react"

import {
  clearLegacyThemeId,
  getLegacyThemeId,
  hasThemePrefs,
  setThemeForAppearance,
  setThemeMode,
} from "../lib/local-storage"
import { rpc } from "../lib/rpc"
import { hasSidecarTransport, onStderr } from "../lib/sidecar-transport"
import { applyTheme, isThemingAvailable } from "../lib/theme-engine"
import { builtinThemeFor, listThemes, loadTheme, themesQueryKey } from "../lib/theme-source"
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
  activeThemeId: string
  appearance: Appearance
  available: boolean
} {
  const { activeThemeId, appearance } = useThemePreference()
  // Lazy-once: the probe is memoised in theme-engine.ts and must not run per render.
  const [available] = useState(() => isThemingAvailable())
  const queryClient = useQueryClient()

  // One-time migration of the pre-§6 single-id preference. The migration
  // logic itself does not live in local-storage.ts: choosing which slot a
  // legacy id belongs in needs the theme's `appearance`, which only the
  // loaded theme list knows.
  //
  // Migrates only when the new three-value key has never been written
  // (hasThemePrefs() false). If prefs already exist, they are the newer
  // intent and a stale legacy id must not overwrite them — getThemePrefs()
  // returns DEFAULT_THEME_PREFS both when prefs were never written and when
  // they were written AS the defaults, so hasThemePrefs() (which reads
  // persisted storage directly) is what tells the two apart.
  //
  // No ref guards this effect — both checks above are already durable
  // across a remount: a completed migration clears the legacy key, and its
  // own writes make hasThemePrefs() true. A ref set before the async work
  // resolves would make StrictMode's double-invoke a permanent no-op: the
  // first pass's result is cancelled, and the second pass would see the
  // ref already set and skip entirely, so the migration would never
  // actually land in dev (main.tsx wraps the app in <StrictMode>). React
  // Query dedupes the two fetchQuery calls a double-invoke starts for the
  // same key, so exactly one migration lands regardless.
  useEffect(() => {
    const legacyId = getLegacyThemeId()
    if (!legacyId || hasThemePrefs()) return
    let cancelled = false
    void queryClient
      .fetchQuery({ queryKey: themesQueryKey, queryFn: listThemes })
      .then((entries) => {
        if (cancelled) return
        const entry = entries.find((e) => e.id === legacyId && !e.error)
        // An id whose theme is no longer installed (or no longer validates)
        // cannot be slotted, so the defaults stand rather than guessing an
        // appearance for it. entry.appearance is checked too: ThemeEntry.
        // appearance admits null for a theme whose own appearance could
        // not be determined (Fix 2), and that cannot be slotted either.
        if (entry?.appearance) {
          setThemeForAppearance(entry.appearance, legacyId)
          setThemeMode(entry.appearance)
        }
        clearLegacyThemeId()
      })
      .catch(() => {
        // List unavailable (no sidecar). Leave the legacy key in place so
        // migration can retry on a later launch rather than silently
        // discarding the user's choice.
      })
    return () => {
      cancelled = true
    }
  }, [queryClient])

  // Bumped only when a hot-reload revalidation finds the ACTIVE theme still
  // valid, so the apply effect below re-runs and re-reads the same id. A
  // revalidation that FAILS does not bump this: per task-13-addendum, the
  // currently applied theme must stay on screen rather than snapping to the
  // appearance's built-in (which loadTheme collapses failures to — correct
  // for startup, where there is no "last good" theme yet, but wrong here).
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

  // activeThemeId can change (user switches theme, or the resolved
  // appearance flips) without the watcher effect below re-subscribing; the
  // listener closure reads this ref instead of depending on activeThemeId
  // directly, so the stderr listener and the startWatch/stopWatch RPC pair
  // aren't torn down and rebuilt on every switch.
  const themeIdRef = useRef(activeThemeId)
  useEffect(() => {
    themeIdRef.current = activeThemeId
  }, [activeThemeId])

  // Tells apart a hot-reload re-apply (reapplyEpoch bumped, activeThemeId
  // unchanged since this effect's previous run) from the initial apply and
  // from a user-driven theme switch (activeThemeId changed). Explicit refs
  // rather than inferring it from reapplyEpoch's value alone: reapplyEpoch
  // can already be > 0 by the time a later activeThemeId switch reruns this
  // effect, so "epoch > 0" alone would misclassify that switch as a
  // hot-reload re-apply too.
  const lastAppliedThemeIdRef = useRef<string | null>(null)
  const lastReapplyEpochRef = useRef(reapplyEpoch)

  useEffect(() => {
    if (!available) return
    // Only a hot-reload re-apply (same activeThemeId as the previous run,
    // with reapplyEpoch — and nothing else — having changed) sets this
    // true. The initial apply (lastAppliedThemeIdRef.current starts null)
    // and an activeThemeId switch both leave it false.
    const isHotReloadReapply =
      lastAppliedThemeIdRef.current === activeThemeId &&
      reapplyEpoch !== lastReapplyEpochRef.current
    lastAppliedThemeIdRef.current = activeThemeId
    lastReapplyEpochRef.current = reapplyEpoch

    let cancelled = false
    void loadTheme(activeThemeId, appearance).then((theme) => {
      if (cancelled) return
      // On the hot-reload path there IS a last-good theme already on
      // screen, so a load that resolves to a DIFFERENT id — loadTheme
      // collapsing a second, now-invalid save to its appearance's built-in
      // — must be refused rather than applied: applying it would strand
      // the app on that built-in until the file becomes valid again
      // (task-13-addendum), exactly what "fall back to the last good
      // theme" forbids. The initial apply and an activeThemeId switch have
      // no last-good theme to protect, so loadTheme's fallback there is
      // correct and must still go through — note loadTheme short-circuits
      // built-in ids, so when the active theme IS a built-in, theme.id
      // legitimately equals activeThemeId and this guard correctly does
      // not trigger.
      if (isHotReloadReapply && theme.id !== activeThemeId) return
      // Checked AFTER the id-guard above, not before: this guard targets a
      // DIFFERENT failure mode — same id, but the file's own `appearance`
      // field was edited to no longer match the slot it is assigned to
      // (final whole-plan review, Fix 1). The id-guard above never refuses
      // that case (the id is unchanged), so it falls through to here
      // regardless of ordering; loadTheme's own fallback paths, in turn,
      // always return a theme whose appearance already matches what was
      // asked for, so this guard never second-guesses the id-guard's
      // fallback result. The two guards are independent — each refuses a
      // different, disjoint mismatch — so either order is safe, but
      // checking id first keeps the existing hot-reload-stranding
      // protection textually first and this newer check an addition after
      // it. Unlike the id-guard (which leaves the last-good theme alone),
      // this one actively applies a safe appearance-correct built-in: an
      // appearance mismatch can originate from the INITIAL apply too (no
      // last-good theme exists yet to fall back to), so doing nothing is
      // not an option here.
      const safeTheme = theme.appearance === appearance ? theme : builtinThemeFor(appearance)
      // The resolved MODE's appearance drives the .dark class (spec §6),
      // not the theme's own `appearance` field — see theme-engine.ts.
      applyTheme(safeTheme, appearance)
    })
    return () => {
      cancelled = true
    }
  }, [activeThemeId, available, reapplyEpoch, appearance])

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
                // collapse to the appearance's built-in anyway — just via a
                // path that looks like "still valid" instead of an
                // intentional one.
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

  return { activeThemeId, appearance, available }
}
