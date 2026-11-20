// Resolves the user's appearance MODE into the appearance actually rendered,
// and exposes the OS preference as a subscribable value.
//
// The resolved appearance — not a theme's own `appearance` field — is what
// drives the `.dark` class. A theme's field governs only which slot
// it is eligible for, so the two cannot disagree.
//
// matchMedia usage mirrors hooks/use-viewport.ts, which already listens to
// media queries this way rather than polling.

import type { Appearance } from "@beadbox/server/theme-tokens"
import type { ThemeMode } from "./local-storage"

const DARK_QUERY = "(prefers-color-scheme: dark)"

export function resolveAppearance(mode: ThemeMode, prefersDark: boolean): Appearance {
  if (mode === "system") return prefersDark ? "dark" : "light"
  return mode
}

export function prefersDarkNow(): boolean {
  // Guarded rather than assumed: older webviews may not implement matchMedia.
  // With NO signal the answer is dark, which is what every other no-signal
  // default in the app says (index.html ships class="dark",
  // DEFAULT_THEME_PREFS.mode is "dark", and clearTheme leaves the dark
  // :root palette). Answering "light" here would put `system` mode on a
  // light theme while the baked palette on screen is still dark.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true
  try {
    return window.matchMedia(DARK_QUERY).matches
  } catch {
    return true
  }
}

export function subscribeSystemAppearance(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {}
  }
  try {
    const mql = window.matchMedia(DARK_QUERY)
    mql.addEventListener("change", listener)
    return () => mql.removeEventListener("change", listener)
  } catch {
    return () => {}
  }
}
