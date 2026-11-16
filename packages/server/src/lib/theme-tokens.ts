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
