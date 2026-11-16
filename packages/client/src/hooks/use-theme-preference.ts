// Owns ONLY the subscription to the single theme-preference store in
// local-storage.ts — the read via useSyncExternalStore plus a setter that
// writes through setThemePreference. It does not apply the theme to
// <html>; that is use-theme.ts's job (its effect runs the loadTheme/
// applyTheme pipeline). A component that only needs to read or change the
// preference (e.g. a settings dialog embedded in a page) should use this
// hook instead of useTheme, so it does not also mount a second applier
// alongside the root's.

import { useCallback, useSyncExternalStore } from "react"

import {
  getThemePreference,
  setThemePreference,
  subscribeThemePreference,
  type ThemeId,
} from "../lib/local-storage"

export function useThemePreference(): {
  themeId: ThemeId
  setTheme: (id: ThemeId) => void
} {
  const themeId = useSyncExternalStore(
    subscribeThemePreference,
    getThemePreference,
    getThemePreference,
  )

  const setTheme = useCallback((id: ThemeId) => {
    setThemePreference(id)
  }, [])

  return { themeId, setTheme }
}
