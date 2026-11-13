// Applies a theme by writing --bb-* custom properties onto <html> and
// toggling the .dark class.
//
// Both halves are required. The class drives Tailwind's
// `@custom-variant dark (&:is(.dark *))` (29 dark: utilities), and the
// MutationObserver in status-colors-mount.tsx is filtered to
// attributeFilter: ["class"], so it never fires on a style change. Writing
// tokens without toggling the class would leave status colours tuned for
// the wrong surface.

import {
  COLOR_KEYS,
  cssVarName,
  FONT_KEYS,
  fontVarName,
  RADIUS_KEYS,
  radiusVarName,
  type Theme,
} from "./theme-tokens"

function allVarNames(): string[] {
  return [
    ...COLOR_KEYS.map(cssVarName),
    ...RADIUS_KEYS.map(radiusVarName),
    ...FONT_KEYS.map(fontVarName),
  ]
}

export function clearTheme(el: HTMLElement = document.documentElement): void {
  for (const name of allVarNames()) el.style.removeProperty(name)
}

export function applyTheme(theme: Theme, el: HTMLElement = document.documentElement): void {
  // Clear first so an optional token the previous theme set (a font, a
  // radius) does not survive into a theme that omits it.
  clearTheme(el)

  for (const key of COLOR_KEYS) {
    el.style.setProperty(cssVarName(key), theme.colors[key])
  }
  if (theme.radius) {
    for (const key of RADIUS_KEYS) {
      const v = theme.radius[key]
      if (v) el.style.setProperty(radiusVarName(key), v)
    }
  }
  if (theme.fonts) {
    for (const key of FONT_KEYS) {
      const v = theme.fonts[key]
      if (v) el.style.setProperty(fontVarName(key), v)
    }
  }

  // Toggle appearance last so observers see a fully-applied theme.
  el.classList.toggle("dark", theme.appearance === "dark")
}
