// The closed token vocabulary. Mirrors the @theme block in index.css 1:1 —
// 19 colours, 4 radii, 2 font stacks. Both the client engine and the
// sidecar's file reader validate against these lists, so the format cannot
// drift from what the stylesheet actually consumes.

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

export const RADIUS_KEYS = ["sm", "md", "lg", "xl"] as const
export const FONT_KEYS = ["sans", "mono"] as const

export type ColorKey = (typeof COLOR_KEYS)[number]
export type Appearance = "dark" | "light"

export interface Theme {
  id: string
  name: string
  appearance: Appearance
  colors: Record<ColorKey, string>
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

export function radiusVarName(key: string): string {
  return `--bb-radius-${key}`
}

export function fontVarName(key: string): string {
  return `--bb-font-${key}`
}
