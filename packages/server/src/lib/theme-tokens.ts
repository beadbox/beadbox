// The closed token vocabulary. Mirrors the @theme block in index.css 1:1 —
// 19 required colours, 3 optional tone colours, 4 radii, 2 font stacks. Both
// the client engine and the sidecar's file reader validate against these
// lists, so the format cannot drift from what the stylesheet actually
// consumes.

export const COLOR_KEYS = [
  "background",
  "foreground",
  "card",
  "cardForeground",
  "popover",
  "popoverForeground",
  "primary",
  "primaryForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
  "destructive",
  "destructiveForeground",
  "border",
  "input",
  "ring",
] as const

/**
 * Semantic tone colours. Optional, unlike COLOR_KEYS: a theme may omit them
 * and DEFAULT_TONE_HEX applies, so theme files predating them stay valid.
 * `destructive` covers the error tone and is not duplicated here. One hex
 * per tone serves both appearances — the text value is derived per surface
 * (toneTextVarName), never authored.
 */
export const TONE_KEYS = ["warning", "info", "success"] as const

/** Defaults when a theme declares no tones: amber-500 / blue-500 / emerald-500. */
export const DEFAULT_TONE_HEX: Readonly<Record<ToneKey, string>> = {
  warning: "#f59e0b",
  info: "#3b82f6",
  success: "#10b981",
}

/**
 * Tokens getting a derived `-text` companion. `destructive` and `primary`
 * are shadcn semantics for a SOLID fill, paired with a `*Foreground`; tinted
 * pills need text readable against the tint instead — bare `text-primary` on
 * its own 15% tint measures 4.09:1 on white. Adds no authorable token.
 */
export const TEXT_DERIVED_KEYS = [...TONE_KEYS, "destructive", "primary"] as const

export const RADIUS_KEYS = ["sm", "md", "lg", "xl"] as const
export const FONT_KEYS = ["sans", "mono"] as const

export type ColorKey = (typeof COLOR_KEYS)[number]
export type ToneKey = (typeof TONE_KEYS)[number]
export type TextDerivedKey = (typeof TEXT_DERIVED_KEYS)[number]
export type Appearance = "dark" | "light"

export interface Theme {
  id: string
  name: string
  appearance: Appearance
  colors: Record<ColorKey, string> & Partial<Record<ToneKey, string>>
  radius?: Partial<Record<(typeof RADIUS_KEYS)[number], string>>
  fonts?: Partial<Record<(typeof FONT_KEYS)[number], string>>
}

/**
 * The single source for the theme-id slug shape; validateTheme() and
 * local-storage.ts both import it so they cannot drift.
 *
 * theme-files.ts keeps its OWN copy (ID_RE) on purpose: that one gates a
 * filesystem path, and stays independent as defence-in-depth. Never DRY it
 * away into this constant.
 */
export const THEME_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** `cardForeground` -> `--bb-card-foreground`. */
export function cssVarName(key: string): string {
  return `--bb-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

/**
 * `warning` -> `--bb-warning-text`. Never authored: theme-engine.ts derives
 * it from the base hex against the theme's `card` via readableTextColor.
 */
export function toneTextVarName(key: TextDerivedKey): string {
  return `--bb-${key}-text`
}

export function radiusVarName(key: string): string {
  return `--bb-radius-${key}`
}

export function fontVarName(key: string): string {
  return `--bb-font-${key}`
}
