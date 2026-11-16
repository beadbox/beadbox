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

import { useEffect, useState } from "react"

import { applyTheme, isThemingAvailable } from "../lib/theme-engine"
import { loadTheme } from "../lib/theme-source"
import { useThemePreference } from "./use-theme-preference"

export function useTheme(): {
  themeId: string
  setTheme: (id: string) => void
  available: boolean
} {
  const { themeId, setTheme } = useThemePreference()
  // Lazy-once: the probe is memoised in theme-engine.ts and must not run per render.
  const [available] = useState(() => isThemingAvailable())

  useEffect(() => {
    if (!available) return
    let cancelled = false
    void loadTheme(themeId).then((theme) => {
      if (!cancelled) applyTheme(theme)
    })
    return () => {
      cancelled = true
    }
  }, [themeId, available])

  return { themeId, setTheme, available }
}
