// beadbox-o3h: per-status colors, the pure half.
//
// A status's color is Beadbox's own setting (stored per workspace in the
// registry, never in bd). With no color chosen, a built-in keeps the Tailwind
// classes each surface has always used: nothing here touches it. A custom
// status with no color chosen gets a generated default that is never grey
// and never a color another status in the project already shows.
//
// Every surface tags its element with data-status and data-status-role, and
// buildStatusColorCss turns the resolved colors into one unlayered stylesheet.
// Tailwind v4 utilities sit in @layer utilities, so an unlayered rule wins
// over them without !important, and no component re-renders on a change.

export const BUILTIN_STATUSES = ["open", "in_progress", "blocked", "deferred", "closed"] as const

export type StatusColorMap = Record<string, string>

/**
 * The hex of the color each status shows today with nothing chosen: the
 * swatch Settings displays, and part of the set a generated default avoids.
 * ready_for_qa / ready_to_ship are custom statuses Beadbox has always drawn
 * purple / emerald; they keep that look.
 */
export const DEFAULT_STATUS_HEX: Readonly<Record<string, string>> = {
  open: "#ffffff",
  in_progress: "#f59e0b",
  blocked: "#3b82f6",
  deferred: "#3b82f6",
  closed: "#71717a",
  ready_for_qa: "#a855f7",
  ready_to_ship: "#10b981",
}

// The blue every badge, pipeline tile and the filter fall back to for a
// status with no entry of its own (bd's pinned / hooked, for one).
const FALLBACK_HEX = "#3b82f6"

// Colors some surface already uses for a status by default (badge, detail
// panel, pipeline tile or molecule graph). A generated default never lands on
// one, so a custom status cannot look like a built-in anywhere.
const RESERVED_HEX = new Set([
  "#ffffff", // open
  "#f59e0b", // in_progress (amber)
  "#3b82f6", // blocked / deferred / unknown badges, in_progress graph node (blue)
  "#06b6d4", // detail-panel fallback (cyan)
  "#71717a", // closed (zinc)
  "#52525b", // closed dot (zinc-600)
  "#6b7280", // blocked graph node (grey)
  "#22c55e", // closed graph node (green)
  "#a855f7", // ready_for_qa (purple)
  "#10b981", // ready_to_ship (emerald)
])

// Saturated, well-separated hues, none near a reserved color.
const PALETTE = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#84cc16", // lime
  "#14b8a6", // teal
  "#6366f1", // indigo
  "#d946ef", // fuchsia
  "#ec4899", // pink
  "#f43f5e", // rose
]

/** The three dark theme variants Beadbox ships, plus white for a future light theme. */
export const THEME_SURFACES: Readonly<Record<string, { background: string; card: string }>> = {
  blue: { background: "#0f172a", card: "#1e293b" },
  gray: { background: "#18181b", card: "#27272a" },
  green: { background: "#0c1a14", card: "#14291e" },
  white: { background: "#ffffff", card: "#ffffff" },
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value)
}

type Rgb = [number, number, number]

function toRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

/** a weighted t, b weighted 1 - t. */
function mix(a: string, b: string, t: number): string {
  const pa = toRgb(a)
  const pb = toRgb(b)
  return toHex([0, 1, 2].map((i) => pa[i] * t + pb[i] * (1 - t)) as Rgb)
}

function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = toRgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  return { h, s, l }
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255])
}

/** Grey, near-white or near-black: never used as a generated default. */
export function isGreyish(hex: string): boolean {
  const { s, l } = hsl(hex)
  return s < 0.25 || l > 0.93 || l < 0.08
}

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio between two colors. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const MIN_CONTRAST = 4.5

/**
 * The text color for a badge of this color: the color itself when it reads
 * at 4.5:1 on its own 20% tint over the surface, otherwise the color mixed
 * toward white (dark surface) or black (light surface) just far enough.
 */
export function readableTextColor(hex: string, surface: string): string {
  const color = hex.toLowerCase()
  const tint = mix(color, surface, 0.2)
  if (contrastRatio(color, tint) >= MIN_CONTRAST) return color
  const target = luminance(surface) < 0.5 ? "#ffffff" : "#000000"
  for (let t = 0.05; t < 1; t += 0.05) {
    const candidate = mix(target, color, t)
    if (contrastRatio(candidate, tint) >= MIN_CONTRAST) return candidate
  }
  return target
}

function hashName(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Default colors for custom statuses, in the order bd lists them. Each status
 * starts at a palette slot hashed from its name and takes the first one not
 * already taken (a built-in's color, a color the user chose for any status,
 * or an earlier custom's default); past the palette, golden-angle hues.
 * Deterministic: the same list and choices give the same colors. Adding a
 * status (Settings appends to the end) never changes an existing one.
 */
export function assignCustomDefaults(
  customs: readonly string[],
  overrides: StatusColorMap = {},
): StatusColorMap {
  const taken = new Set(RESERVED_HEX)
  for (const v of Object.values(overrides)) if (isHexColor(v)) taken.add(v.toLowerCase())
  const out: StatusColorMap = {}
  for (const name of customs) {
    const known = DEFAULT_STATUS_HEX[name]
    const overridden = new Set(Object.values(overrides).map((v) => String(v).toLowerCase()))
    if (known && !overridden.has(known)) {
      out[name] = known
      continue
    }
    const start = hashName(name)
    let chosen: string | undefined
    for (let k = 0; k < PALETTE.length && !chosen; k++) {
      const candidate = PALETTE[(start + k) % PALETTE.length]
      if (!taken.has(candidate)) chosen = candidate
    }
    for (let k = 0; !chosen; k++) {
      const candidate = fromHsl(((start % 360) + k * 137.508) % 360, 0.7, 0.55)
      if (!taken.has(candidate) && !isGreyish(candidate)) chosen = candidate
    }
    taken.add(chosen)
    out[name] = chosen
  }
  return out
}

/**
 * Resolve the project's colors.
 *  css:     the statuses the stylesheet must recolor (a chosen color, or a
 *           custom's generated default that differs from its classes today).
 *           A built-in with nothing chosen is absent: it keeps its classes.
 *  display: every status's effective color (swatches, the molecule graph).
 * A chosen color for a status the project no longer has is ignored.
 *
 * `customs` is the project's status.custom list. Every other status is a bd
 * built-in, including any beyond the five (bd 1.3 also lists pinned and
 * hooked): it keeps its classes, and its swatch is the blue every surface
 * falls back to. Without `customs`, only the five count as built-in.
 */
export function resolveStatusColors(
  statuses: readonly string[],
  overrides: StatusColorMap,
  customs?: readonly string[],
): { css: StatusColorMap; display: StatusColorMap; defaults: StatusColorMap } {
  const present = new Set(statuses)
  const live: StatusColorMap = {}
  for (const [k, v] of Object.entries(overrides)) {
    if (present.has(k) && isHexColor(v)) live[k] = v.toLowerCase()
  }
  const customSet = new Set(customs ?? statuses.filter((s) => !(BUILTIN_STATUSES as readonly string[]).includes(s)))
  const builtins = new Set(statuses.filter((s) => !customSet.has(s)))
  const generated = assignCustomDefaults(
    statuses.filter((s) => customSet.has(s)),
    live,
  )
  const css: StatusColorMap = {}
  const display: StatusColorMap = {}
  const defaults: StatusColorMap = {}
  for (const s of statuses) {
    const def = builtins.has(s) ? (DEFAULT_STATUS_HEX[s] ?? FALLBACK_HEX) : generated[s]
    defaults[s] = def
    display[s] = live[s] ?? def
    if (live[s]) css[s] = live[s]
    else if (!builtins.has(s) && def !== DEFAULT_STATUS_HEX[s]) css[s] = def
  }
  return { css, display, defaults }
}

/** Escape text for a double-quoted CSS string: anything but [A-Za-z0-9_-] becomes a hex escape. */
export function cssEscapeIdent(s: string): string {
  let out = ""
  for (const ch of s) {
    out += /[A-Za-z0-9_-]/.test(ch) ? ch : `\\${(ch.codePointAt(0) ?? 0).toString(16)} `
  }
  return out
}

/** The stylesheet for the resolved colors; surface is the theme's card color. */
export function buildStatusColorCss(css: StatusColorMap, surface: string): string {
  const rules: string[] = []
  for (const [name, hex] of Object.entries(css)) {
    if (!isHexColor(hex)) continue
    const [r, g, b] = toRgb(hex)
    const text = readableTextColor(hex, surface)
    const sel = `[data-status="${cssEscapeIdent(name)}"]`
    const tint = `rgb(${r} ${g} ${b} / 0.2)`
    const edge = `rgb(${r} ${g} ${b} / 0.4)`
    rules.push(
      `${sel}[data-status-role="badge"]{background-color:${tint};border-color:${edge};color:${text}}`,
      `${sel}[data-status-role="stage"]{background-color:${tint};border-color:${edge}}`,
      `${sel}[data-status-role="text"]{color:${text}}`,
      `${sel}[data-status-role="dot"]{background-color:${hex.toLowerCase()}}`,
    )
  }
  return rules.join("\n")
}
