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

/**
 * Statuses whose default colour is the THEME'S FOREGROUND, not a fixed hex.
 *
 * `open` means "no colour of its own": it has always drawn in the body text
 * colour. As a literal that was #ffffff, which is only correct while every
 * theme is dark — on a white card its 20% tint is white-on-white, contrast
 * 1.00, an invisible badge. Resolving it from the theme instead follows ANY
 * theme, including a user's, in either appearance.
 *
 * DEFAULT_STATUS_HEX.open stays #ffffff: it is still the right swatch for
 * the dark default, and it is a member of RESERVED_HEX, which a generated
 * custom colour must keep avoiding.
 */
export const FOREGROUND_DEFAULT_STATUSES: ReadonlySet<string> = new Set(["open"])

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

const RGB_FN = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/

/**
 * Normalises a theme colour to 6-digit hex. Theme files may legally write a
 * token as rgb() (theme-validate.ts), but every function here parses hex, so
 * an unnormalised rgb() surface silently yields black text rather than an
 * error. Returns null for anything unrecognised so callers can skip instead
 * of painting a wrong colour.
 */
export function toHexColor(value: string): string | null {
  const v = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
  const m = RGB_FN.exec(v)
  if (!m) return null
  return `#${[1, 2, 3]
    .map((i) => Math.min(255, Number(m[i])).toString(16).padStart(2, "0"))
    .join("")}`
}

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
  opts: { foreground?: string } = {},
): {
  css: StatusColorMap
  chosen: StatusColorMap
  display: StatusColorMap
  defaults: StatusColorMap
} {
  // Defaults to the dark literal so a caller that cannot read the DOM (and
  // every existing test) behaves exactly as before.
  const foreground = isHexColor(opts.foreground ?? "")
    ? (opts.foreground as string).toLowerCase()
    : DEFAULT_STATUS_HEX.open
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
  const chosen: StatusColorMap = {}
  const display: StatusColorMap = {}
  const defaults: StatusColorMap = {}
  for (const s of statuses) {
    const builtinDef = FOREGROUND_DEFAULT_STATUSES.has(s)
      ? foreground
      : (DEFAULT_STATUS_HEX[s] ?? FALLBACK_HEX)
    const def = builtins.has(s) ? builtinDef : generated[s]
    defaults[s] = def
    display[s] = live[s] ?? def
    // Every status now emits a stylesheet rule, built-ins included. Before
    // tone/light themes a built-in with no chosen colour kept the hardcoded
    // Tailwind classes on each surface; those are dark-only. Routing it here
    // instead gives it readableTextColor's per-surface text for free, and
    // makes a built-in and a custom status behave identically.
    css[s] = live[s] ?? def
    // `chosen` carries ONLY a colour the user picked or one generated for a
    // custom status — what `css` meant before built-ins started emitting
    // rules. The molecule graph keys its own palette off this: with `css` it
    // would never reach that palette again, so its node colours would have
    // changed silently for every workspace using the defaults.
    if (live[s]) chosen[s] = live[s]
    else if (!builtins.has(s) && def !== DEFAULT_STATUS_HEX[s]) chosen[s] = def
  }
  return { css, chosen, display, defaults }
}

/** Escape text for a double-quoted CSS string: anything but [A-Za-z0-9_-] becomes a hex escape. */
export function cssEscapeIdent(s: string): string {
  let out = ""
  for (const ch of s) {
    out += /[A-Za-z0-9_-]/.test(ch) ? ch : `\\${(ch.codePointAt(0) ?? 0).toString(16)} `
  }
  return out
}

/**
 * One colour's worth of rules, for one `data-<attr>` value. Shared by the
 * status and priority stylesheets so the tint/edge/readable-text arithmetic
 * exists once: a change to how a colour becomes a badge cannot apply to
 * statuses and miss priorities.
 *
 * `emphasis` scales the fill and border alpha. The hardcoded classes carried
 * the priority ramp partly in alpha (P0 was `bg-red-500/20`, P2
 * `bg-yellow-500/10`), so a uniform fill would have flattened it.
 */
function colorRules(
  attr: "status" | "priority" | "type",
  name: string,
  hex: string,
  surface: string,
  prefix: string,
  emphasis = 1,
  edgeEmphasis = emphasis,
): string[] {
  const [r, g, b] = toRgb(hex)
  const text = readableTextColor(hex, surface)
  const sel = `${prefix}[data-${attr}="${cssEscapeIdent(name)}"]`
  const role = (n: string) => `${sel}[data-${attr}-role="${n}"]`
  // Round: 0.4 * 0.75 is 0.30000000000000004 in binary floating point, which
  // is valid CSS but noise in the stylesheet (and in any test reading it).
  const alpha = (base: number, mult: number) => Number((base * mult).toFixed(3))
  const tint = `rgb(${r} ${g} ${b} / ${alpha(0.2, emphasis)})`
  const edge = `rgb(${r} ${g} ${b} / ${alpha(0.4, edgeEmphasis)})`
  return [
    `${role("badge")}{background-color:${tint};border-color:${edge};color:${text}}`,
    `${role("stage")}{background-color:${tint};border-color:${edge}}`,
    `${role("text")}{color:${text}}`,
    `${role("dot")}{background-color:${hex.toLowerCase()}}`,
  ]
}

/**
 * The stylesheet for the resolved colors; surface is the theme's card color.
 * With a `scope` (a workspace id), every rule only matches inside elements
 * tagged data-project-id with that id: the All projects view styles each
 * project's rows with that project's own colors (beadbox-t6x).
 */
export function buildStatusColorCss(css: StatusColorMap, surface: string, scope?: string): string {
  const rules: string[] = []
  const prefix = scope === undefined ? "" : `[data-project-id="${cssEscapeIdent(scope)}"] `
  for (const [name, hex] of Object.entries(css)) {
    if (!isHexColor(hex)) continue
    rules.push(...colorRules("status", name, hex, surface, prefix))
  }
  return rules.join("\n")
}

/**
 * Priority colours, the hues the hardcoded classes used: red / orange /
 * yellow / slate / zinc. Unlike statuses these are not user-configurable and
 * not per project, so one unscoped stylesheet covers the app.
 *
 * They go through the same machinery purely for the per-surface text: as
 * literals, `text-orange-400` on a white card fails contrast.
 */
export const DEFAULT_PRIORITY_HEX: Readonly<Record<string, string>> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#64748b",
  backlog: "#71717a",
}

// Matches the alpha the hardcoded classes used, so the ramp survives:
// P0/P1/P3 filled at /20 + /40, P2/P4 at /10 + /25.
const PRIORITY_EMPHASIS: Readonly<Record<string, number>> = {
  critical: 1,
  high: 1,
  medium: 0.5,
  low: 1,
  backlog: 0.5,
}

/**
 * Bead-type colours, the hues `typeColors` hardcoded. BeadType is an open
 * vocabulary (a workspace may define its own), so this covers the types
 * Beadbox has always drawn and a type with no entry keeps a tokenised
 * neutral fallback rather than a generated hue — matching today's behaviour,
 * where an unknown type drew slate.
 */
export const DEFAULT_TYPE_HEX: Readonly<Record<string, string>> = {
  bug: "#ef4444",
  task: "#3b82f6",
  feature: "#a855f7",
  epic: "#f59e0b",
  chore: "#64748b",
  message: "#06b6d4",
  gate: "#22c55e",
  "merge-request": "#14b8a6",
  molecule: "#ec4899",
  agent: "#8b5cf6",
  role: "#0ea5e9",
  rig: "#f97316",
  convoy: "#84cc16",
  event: "#f43f5e",
  // epic-tree draws a milestone's Flag in sky; it had no entry here.
  milestone: "#38bdf8",
}

export function buildTypeColorCss(surface: string): string {
  const rules: string[] = []
  for (const [name, hex] of Object.entries(DEFAULT_TYPE_HEX)) {
    // typeColors tinted at /20 with a /30 edge; 0.75 emphasis reproduces the
    // slightly softer border those classes used.
    rules.push(...colorRules("type", name, hex, surface, "", 1, 0.75))
  }
  return rules.join("\n")
}

export function buildPriorityColorCss(surface: string): string {
  const rules: string[] = []
  for (const [name, hex] of Object.entries(DEFAULT_PRIORITY_HEX)) {
    rules.push(...colorRules("priority", name, hex, surface, "", PRIORITY_EMPHASIS[name] ?? 1))
  }
  return rules.join("\n")
}
