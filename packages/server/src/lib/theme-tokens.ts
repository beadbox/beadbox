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
 * Semantic tone colours: warning, info, success. Optional, unlike
 * COLOR_KEYS — none of the 19 required tokens expresses these roles, and
 * before they existed ~424 call sites hardcoded a Tailwind palette literal
 * (`bg-amber-500/15 text-amber-400`), which no theme could reach.
 *
 * A theme may omit them; DEFAULT_TONE_HEX then applies, so every theme file
 * written before these tokens existed stays valid. `destructive` already
 * covers the error tone and is deliberately NOT duplicated here.
 *
 * One hex per tone serves BOTH appearances: the readable text colour is
 * DERIVED per surface by the engine (see toneTextVarName), never authored.
 */
export const TONE_KEYS = ["warning", "info", "success"] as const

/**
 * The tone values a theme gets when it declares none. These are the Tailwind
 * shades the hardcoded call sites used (amber-500 / blue-500 / emerald-500),
 * so an existing theme keeps the look it had before tone tokens existed.
 */
export const DEFAULT_TONE_HEX: Readonly<Record<ToneKey, string>> = {
  warning: "#f59e0b",
  info: "#3b82f6",
  success: "#10b981",
}

/**
 * Tokens that receive a DERIVED `-text` companion: the three tones plus
 * `destructive` and `primary`, both already authorable in COLOR_KEYS.
 *
 * `destructive` and `primary` are shadcn semantics for a SOLID fill, paired
 * with a `*Foreground` for text ON that fill. Tinted pills here need text
 * readable against a 20% tint instead — the same problem the tones have, and
 * measurably: `text-primary` on its own 15% tint is 5.01:1 on the dark card
 * but only 4.09:1 on a white one. Deriving adds no authorable token.
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
 * The theme-id slug format: a lowercase letter or digit, then up to 63 more
 * lowercase letters, digits, underscores or hyphens. The single source for
 * this shape — theme-validate.ts's validateTheme() and the client's
 * local-storage.ts (getThemePrefs, setThemeForAppearance, getLegacyThemeId)
 * both import it, so neither can drift from the other.
 *
 * theme-files.ts keeps its OWN copy (ID_RE) on purpose: that one gates a
 * filesystem path built from the id, and stays independent as
 * defence-in-depth — never DRY that one away into this constant.
 */
export const THEME_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** `cardForeground` -> `--bb-card-foreground`. */
export function cssVarName(key: string): string {
  return `--bb-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

/**
 * The DERIVED readable-text variable for a tone: `warning` ->
 * `--bb-warning-text`. Never authored in a theme file — theme-engine.ts
 * computes it from the tone's base hex against the theme's `card` surface
 * via readableTextColor, which is what makes one authored hex work in both
 * appearances.
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
