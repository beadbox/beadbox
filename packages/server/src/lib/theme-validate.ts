// Pure validation — no DOM, no fs, so the sidecar and the client share it.
//
// Colours are restricted to hex and rgb() deliberately. oklch() renders
// correctly on current WebKit, but the spike that established that could
// only test macOS 27 while tauri.conf.json supports 13.0+. A format
// restriction is cheap to relax later and impossible to tighten once
// users' theme files depend on it.

import {
  type Appearance,
  COLOR_KEYS,
  FONT_KEYS,
  RADIUS_KEYS,
  THEME_ID_RE,
  type Theme,
} from "./theme-tokens"

const HEX = /^#[0-9a-fA-F]{6}$/
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/
// Lengths and calc() only: digits, units, arithmetic, spaces. Excludes ; } { :
// quotes and backslash — it does NOT exclude url( (it admits u, r, l and "(").
// That's fine: these values only ever reach --bb-radius-*, consumed as
// border-radius (which doesn't accept url()), and every write goes through
// el.style.setProperty rather than string concatenation into a stylesheet, so
// there is no CSSOM sink for a url(...) value to inject through.
const LENGTH = /^[0-9a-zA-Z.%+\-*/() ]{1,64}$/
const FONT_STACK = /^[0-9a-zA-Z.,'"_\- ]{1,200}$/

export type ValidationResult = { ok: true; theme: Theme } | { ok: false; error: string }

function fail(error: string): ValidationResult {
  return { ok: false, error }
}

export function isValidColor(value: string): boolean {
  return HEX.test(value) || RGB.test(value)
}

export function validateTheme(input: unknown, opts: { id?: string } = {}): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("theme must be a JSON object")
  }
  const t = input as Record<string, unknown>

  if (typeof t.id !== "string" || !THEME_ID_RE.test(t.id)) {
    return fail("id must be a lowercase slug of 1-64 chars ([a-z0-9_-])")
  }
  if (opts.id !== undefined && t.id !== opts.id) {
    return fail(`id "${t.id}" must match the filename stem "${opts.id}"`)
  }
  if (typeof t.name !== "string" || t.name.trim() === "" || t.name.length > 64) {
    return fail("name must be a non-empty string of at most 64 chars")
  }
  if (t.appearance !== "dark" && t.appearance !== "light") {
    return fail('appearance must be "dark" or "light"')
  }

  if (typeof t.colors !== "object" || t.colors === null || Array.isArray(t.colors)) {
    return fail("colors must be an object")
  }
  const colors = t.colors as Record<string, unknown>
  for (const key of Object.keys(colors)) {
    if (!(COLOR_KEYS as readonly string[]).includes(key)) {
      return fail(`colors.${key} is not a known colour token`)
    }
  }
  for (const key of COLOR_KEYS) {
    const v = colors[key]
    if (typeof v !== "string") return fail(`colors.${key} is missing`)
    if (!isValidColor(v)) {
      return fail(`colors.${key} must be hex (#rrggbb) or rgb(); got "${v}"`)
    }
  }

  if (t.radius !== undefined) {
    if (typeof t.radius !== "object" || t.radius === null || Array.isArray(t.radius)) {
      return fail("radius must be an object")
    }
    for (const [k, v] of Object.entries(t.radius as Record<string, unknown>)) {
      if (!(RADIUS_KEYS as readonly string[]).includes(k)) {
        return fail(`radius.${k} is not a known radius token`)
      }
      if (typeof v !== "string" || !LENGTH.test(v)) {
        return fail(`radius.${k} must be a CSS length; got "${String(v)}"`)
      }
    }
  }

  if (t.fonts !== undefined) {
    if (typeof t.fonts !== "object" || t.fonts === null || Array.isArray(t.fonts)) {
      return fail("fonts must be an object")
    }
    for (const [k, v] of Object.entries(t.fonts as Record<string, unknown>)) {
      if (!(FONT_KEYS as readonly string[]).includes(k)) {
        return fail(`fonts.${k} is not a known font token`)
      }
      if (typeof v !== "string" || !FONT_STACK.test(v)) {
        return fail(`fonts.${k} must be a plain font stack; got "${String(v)}"`)
      }
    }
  }

  return { ok: true, theme: input as unknown as Theme }
}

export type { Appearance, Theme }
