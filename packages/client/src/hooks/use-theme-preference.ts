// Owns ONLY the subscription to the theme-preference store in
// local-storage.ts, plus the derivation of the appearance actually
// rendered. It does not apply the theme to <html>; that is use-theme.ts's
// job (its effect runs the loadTheme/applyTheme pipeline). A component
// that only needs to read or change the preference (e.g. a settings
// dialog embedded in a page) should use this hook instead of useTheme, so
// it does not also mount a second applier alongside the root's.

import type { Appearance } from "@beadbox/server/theme-tokens"
import { useCallback, useSyncExternalStore } from "react"
import { prefersDarkNow, resolveAppearance, subscribeSystemAppearance } from "../lib/appearance"
import {
  getThemePrefs,
  setThemeForAppearance as persistThemeForAppearance,
  setThemeMode as persistThemeMode,
  subscribeThemePreference,
  type ThemeId,
  type ThemeMode,
} from "../lib/local-storage"

export function useThemePreference(): {
  mode: ThemeMode
  darkThemeId: ThemeId
  lightThemeId: ThemeId
  appearance: Appearance
  activeThemeId: ThemeId
  setMode: (mode: ThemeMode) => void
  setThemeForAppearance: (appearance: Appearance, id: ThemeId) => void
} {
  const prefs = useSyncExternalStore(subscribeThemePreference, getThemePrefs, getThemePrefs)

  // The OS preference is a second store: in system mode the rendered
  // appearance can change without any preference write, so it needs its own
  // subscription or the app would only follow the OS at startup.
  const prefersDark = useSyncExternalStore(
    subscribeSystemAppearance,
    prefersDarkNow,
    prefersDarkNow,
  )

  const appearance = resolveAppearance(prefs.mode, prefersDark)
  const activeThemeId = appearance === "dark" ? prefs.darkThemeId : prefs.lightThemeId

  const setMode = useCallback((mode: ThemeMode) => {
    persistThemeMode(mode)
  }, [])

  const setThemeForAppearance = useCallback((a: Appearance, id: ThemeId) => {
    persistThemeForAppearance(a, id)
  }, [])

  return {
    mode: prefs.mode,
    darkThemeId: prefs.darkThemeId,
    lightThemeId: prefs.lightThemeId,
    appearance,
    activeThemeId,
    setMode,
    setThemeForAppearance,
  }
}
