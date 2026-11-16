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
} from "@beadbox/server/theme-tokens"
import { applyThemeClass } from "./theme"

function allVarNames(): string[] {
  return [
    ...COLOR_KEYS.map(cssVarName),
    ...RADIUS_KEYS.map(radiusVarName),
    ...FONT_KEYS.map(fontVarName),
  ]
}

export function clearTheme(el: HTMLElement = document.documentElement): void {
  // Deliberately does NOT reset the .dark class. The :root defaults ARE the
  // dark palette, and index.html ships class="dark". So the cleared state IS
  // the dark theme. Removing the class here would leave dark-palette tokens
  // driving light-mode `dark:` utilities — a state no theme represents.
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
  // Delegates to theme.ts's applyThemeClass so exactly one function in
  // the codebase maps an Appearance to the dark class.
  applyThemeClass(el, theme.appearance)
}

// --- startup probe -------------------------------------------------------
//
// Bounds the risk the 2026-11-13 spike could not clear: it ran on macOS 27
// only, while tauri.conf.json supports 13.0+.
//
// Detects NON-RESOLUTION: a var() the engine cannot walk falls back to the
// property's initial value — `transparent` for background-color, which
// getComputedStyle reports as "rgba(0, 0, 0, 0)".
//
// It does NOT confirm the resolved value is *correct*: getComputedStyle
// echoes whatever colour value the engine resolved to, without validation.
// Hex-only token format guards against colour mis-resolution. This probe
// only tests whether the engine walked the indirection at all.

const PROBE_VAR = "--bb-probe-sentinel"
const PROBE_RGB = "rgb(1, 2, 3)"

let cachedProbe: boolean | null = null

export function probeTokenSupport(el: HTMLElement = document.documentElement): boolean {
  const probe = document.createElement("div")
  probe.setAttribute("data-bb-probe", "")
  probe.style.position = "absolute"
  probe.style.width = "1px"
  probe.style.height = "1px"
  probe.style.opacity = "0"
  probe.style.pointerEvents = "none"
  probe.style.setProperty(PROBE_VAR, PROBE_RGB)
  probe.style.backgroundColor = `var(${PROBE_VAR})`
  el.ownerDocument.body.appendChild(probe)
  try {
    const resolved = el.ownerDocument.defaultView?.getComputedStyle(probe).backgroundColor.trim()
    if (!resolved) return false
    // Engine echoed the declaration back without resolving it.
    if (resolved.includes("var(")) return false
    // Unresolvable var() falls back to the property's initial value, `transparent`.
    // Engines differ in how they serialise it — spacing varies, and CSS Color 4
    // unified rgb()/rgba(), so both function names can carry four components.
    // Match any all-zero rgb/rgba rather than enumerating spellings.
    const compact = resolved.replace(/\s/g, "")
    if (/^rgba?\(0,0,0,0\)$/.test(compact) || compact === "transparent") {
      return false
    }
    return true
  } finally {
    probe.remove()
  }
}

/** Memoised probe result. Theming is disabled for the session when false. */
export function isThemingAvailable(): boolean {
  if (cachedProbe === null) {
    try {
      cachedProbe = probeTokenSupport()
    } catch {
      // A probe failure must never take the app down; assume unavailable
      // and let the baked :root literals render.
      cachedProbe = false
    }
  }
  return cachedProbe
}

/** Test seam. */
export function __resetProbeCache(): void {
  cachedProbe = null
}
