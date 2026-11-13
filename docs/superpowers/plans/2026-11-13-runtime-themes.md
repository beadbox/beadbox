# Runtime Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore runtime theme switching, ship a light theme, and let users load their own themes from `~/.beadbox/themes/*.json`.

**Architecture:** `index.css`'s `@theme inline` block changes from baked literals to one level of `var(--bb-*)` indirection, with today's gray values as `:root` defaults. A client-side engine writes `--bb-*` onto `documentElement.style` and toggles the `.dark` class. Built-in themes are bundled JSON loaded through the same path as user themes, which the Node sidecar reads from disk and serves over kkrpc.

**Tech Stack:** TypeScript, React 19, Tailwind v4 (`@theme inline`), TanStack Query + Router, kkrpc over a Tauri sidecar, `bun test` + happy-dom, Playwright for E2E, Biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-11-13-runtime-themes-design.md`

## Global Constraints

- **Colour values: hex (`#rrggbb`) or `rgb()` only.** `oklch()` and `color-mix()` are rejected by validation. Reason: the spike could not clear macOS 13–15.
- **`minimumSystemVersion` is `13.0`** (`src-tauri/tauri.conf.json`). Never assume current-WebKit behaviour.
- **All 19 colour keys are required** in a theme file. `radius` and `fonts` are optional; unset keys fall back to built-in defaults.
- **Unknown keys are rejected**, so a typo is reported rather than silently ignored.
- **A malformed theme is rejected atomically** — never half-applied. Fall back to the last good theme and name the offending key.
- **Token vocabulary is closed**: 19 `--color-*`, 4 `--radius-*`, 2 `--font-*`. No new tokens are invented.
- Client tests run under `bun test` with happy-dom registered via the preload in `packages/client/bunfig.toml`.
- Run `bun run check` (Biome) before each commit.

## The 19 colour tokens (canonical order)

`background`, `foreground`, `card`, `cardForeground`, `popover`, `popoverForeground`,
`primary`, `primaryForeground`, `secondary`, `secondaryForeground`, `muted`,
`mutedForeground`, `accent`, `accentForeground`, `destructive`,
`destructiveForeground`, `border`, `input`, `ring`

JSON uses camelCase; the CSS custom property is the kebab-case form prefixed
`--bb-` (`cardForeground` → `--bb-card-foreground`).

---

## File Structure

**Create:**
- `packages/client/src/lib/theme-tokens.ts` — token vocabulary, types, camel↔kebab mapping. The single source of truth both client and validation import.
- `packages/client/src/lib/theme-validate.ts` — pure validation. No DOM, no fs.
- `packages/client/src/lib/theme-engine.ts` — applies tokens to the DOM, toggles `.dark`, runs the startup probe.
- `packages/client/src/lib/theme-source.ts` — merges bundled built-ins with `rpc.themes.*`.
- `packages/client/src/themes/beadbox-dark.json`, `packages/client/src/themes/beadbox-light.json`
- `packages/server/src/lib/theme-files.ts` — reads and validates theme files on disk, reporting invalid ones in place.
- `packages/server/src/handlers/themes.ts` — kkrpc namespace.

**Modify:**
- `packages/client/src/index.css` — `@theme inline` indirection; delete `.dark.theme-gray` / `.dark.theme-green`.
- `packages/client/index.html` — `class="dark theme-gray"` → `class="dark"`.
- `packages/client/src/lib/local-storage.ts` — `ThemeVariant` becomes a string id.
- `packages/client/src/lib/theme.ts` — `applyThemeClass` becomes appearance-only.
- `packages/client/src/lib/status-colors-store.ts` — `currentThemeSurface` derives from the active theme, not a class table.
- `packages/server/src/handlers/index.ts` — register the `themes` namespace.

**Rewrite:** `packages/client/src/__tests__/theme.test.ts` (it asserts the limitation being removed).

---

### Task 1: Token vocabulary and validation

**Files:**
- Create: `packages/client/src/lib/theme-tokens.ts`
- Create: `packages/client/src/lib/theme-validate.ts`
- Test: `packages/client/src/__tests__/theme-validate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `COLOR_KEYS: readonly string[]` (19 entries, canonical order)
  - `RADIUS_KEYS: readonly string[]` (`sm`,`md`,`lg`,`xl`)
  - `FONT_KEYS: readonly string[]` (`sans`,`mono`)
  - `type Theme = { id: string; name: string; appearance: "dark"|"light"; colors: Record<string,string>; radius?: Record<string,string>; fonts?: Record<string,string> }`
  - `cssVarName(key: string): string` — `cardForeground` → `--bb-card-foreground`
  - `validateTheme(input: unknown, opts?: { id?: string }): { ok: true; theme: Theme } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/__tests__/theme-validate.test.ts
import { describe, expect, test } from "bun:test"
import { COLOR_KEYS, cssVarName } from "../lib/theme-tokens"
import { validateTheme } from "../lib/theme-validate"

const colors = (over: Record<string, string> = {}) =>
  Object.fromEntries(COLOR_KEYS.map((k) => [k, "#101010"])) as Record<string, string>
const base = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "nord", name: "Nord", appearance: "dark", colors: colors(), ...over,
})

describe("cssVarName", () => {
  test("camelCase becomes kebab-case with the --bb- prefix", () => {
    expect(cssVarName("background")).toBe("--bb-background")
    expect(cssVarName("cardForeground")).toBe("--bb-card-foreground")
    expect(cssVarName("destructiveForeground")).toBe("--bb-destructive-foreground")
  })
})

describe("validateTheme", () => {
  test("accepts a complete theme", () => {
    const r = validateTheme(base())
    expect(r.ok).toBe(true)
  })

  test("accepts rgb() colours", () => {
    const r = validateTheme(base({ colors: colors() , }))
    expect(r.ok).toBe(true)
    const r2 = validateTheme(base({ colors: { ...colors(), background: "rgb(1, 2, 3)" } }))
    expect(r2.ok).toBe(true)
  })

  test("rejects oklch and names the key", () => {
    const r = validateTheme(base({ colors: { ...colors(), background: "oklch(1 0 0)" } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("colors.background")
  })

  test("rejects color-mix", () => {
    const r = validateTheme(base({ colors: { ...colors(), ring: "color-mix(in srgb, red, blue)" } }))
    expect(r.ok).toBe(false)
  })

  test("rejects a missing colour key and names it", () => {
    const c = colors()
    delete (c as Record<string, string>).ring
    const r = validateTheme(base({ colors: c }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("ring")
  })

  test("rejects an unknown colour key", () => {
    const r = validateTheme(base({ colors: { ...colors(), bogus: "#fff" } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("bogus")
  })

  test("requires appearance to be dark or light", () => {
    expect(validateTheme(base({ appearance: "neon" })).ok).toBe(false)
    expect(validateTheme(base({ appearance: undefined })).ok).toBe(false)
  })

  test("radius and fonts are optional", () => {
    expect(validateTheme(base({ radius: undefined, fonts: undefined })).ok).toBe(true)
    expect(validateTheme(base({ radius: { md: "0.5rem" } })).ok).toBe(true)
  })

  test("rejects a radius value containing CSS punctuation", () => {
    const r = validateTheme(base({ radius: { md: "1rem; } body { display:none" } }))
    expect(r.ok).toBe(false)
  })

  test("rejects an id that does not match the expected filename stem", () => {
    const r = validateTheme(base({ id: "nord" }), { id: "arctic" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("id")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/theme-validate.test.ts`
Expected: FAIL — cannot resolve `../lib/theme-tokens`.

- [ ] **Step 3: Write `theme-tokens.ts`**

```ts
// packages/client/src/lib/theme-tokens.ts
// The closed token vocabulary. Mirrors the @theme block in index.css 1:1 —
// 19 colours, 4 radii, 2 font stacks. Both the client engine and the
// sidecar's file reader validate against these lists, so the format cannot
// drift from what the stylesheet actually consumes.

export const COLOR_KEYS = [
  "background", "foreground",
  "card", "cardForeground",
  "popover", "popoverForeground",
  "primary", "primaryForeground",
  "secondary", "secondaryForeground",
  "muted", "mutedForeground",
  "accent", "accentForeground",
  "destructive", "destructiveForeground",
  "border", "input", "ring",
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
```

- [ ] **Step 4: Write `theme-validate.ts`**

```ts
// packages/client/src/lib/theme-validate.ts
// Pure validation — no DOM, no fs, so the sidecar and the client share it.
//
// Colours are restricted to hex and rgb() deliberately. oklch() renders
// correctly on current WebKit, but the spike that established that could
// only test macOS 27 while tauri.conf.json supports 13.0+. A format
// restriction is cheap to relax later and impossible to tighten once
// users' theme files depend on it.

import {
  COLOR_KEYS, FONT_KEYS, RADIUS_KEYS, type Appearance, type Theme,
} from "./theme-tokens"

const HEX = /^#[0-9a-fA-F]{6}$/
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/
// Lengths and calc() only: digits, units, arithmetic, spaces. Excludes ; } and
// url( so a theme file can never terminate a declaration and inject CSS.
const LENGTH = /^[0-9a-zA-Z.%+\-*/() ]{1,64}$/
const FONT_STACK = /^[0-9a-zA-Z.,'"_\- ]{1,200}$/

export type ValidationResult =
  | { ok: true; theme: Theme }
  | { ok: false; error: string }

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

  if (typeof t.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.id)) {
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/theme-validate.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Lint and commit**

```bash
bun run check
git add packages/client/src/lib/theme-tokens.ts packages/client/src/lib/theme-validate.ts packages/client/src/__tests__/theme-validate.test.ts
git commit -m "feat(themes): token vocabulary and theme-file validation"
```

---

### Task 2: Built-in theme files

**Files:**
- Create: `packages/client/src/themes/beadbox-dark.json`
- Create: `packages/client/src/themes/beadbox-light.json`
- Test: `packages/client/src/__tests__/builtin-themes.test.ts`

**Interfaces:**
- Consumes: `validateTheme` from Task 1.
- Produces: two JSON files importable as `Theme` after validation.

**Context:** `beadbox-dark.json` reproduces today's `@theme` literals exactly, so
switching to it is a no-op. `beadbox-light.json` derives from the light palette
already sitting unused in `index.css`'s `:root`, converted from `oklch()` to hex,
with **two corrections** (both verified by contrast measurement):

| Token | Dormant value | Shipped value | Why |
|---|---|---|---|
| `destructiveForeground` | `#e7000b` | `#ffffff` | Dormant value equals `destructive` — red on red, invisible. White gives 4.77:1 (AA). |
| `primary` | `#171717` | `#15803d` | Near-black abandons Beadbox's green. `#15803d` gives white-on-it 5.02:1 (AA); `#22c55e` and `#16a34a` fail at 2.28:1 and 3.30:1. |
| `primaryForeground` | `#fafafa` | `#ffffff` | Pairs with the above. |
| `ring` | `#a1a1a1` | `#16a34a` | Brand-green focus ring; 3.30:1 on white meets AA for non-text. |

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/__tests__/builtin-themes.test.ts
import { describe, expect, test } from "bun:test"
import dark from "../themes/beadbox-dark.json"
import light from "../themes/beadbox-light.json"
import { COLOR_KEYS } from "../lib/theme-tokens"
import { validateTheme } from "../lib/theme-validate"

// Contrast per WCAG 2.1 relative luminance.
function lum(hex: string): number {
  const h = hex.replace("#", "")
  const c = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255)
  const l = c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe("built-in themes", () => {
  test("both validate", () => {
    expect(validateTheme(dark, { id: "beadbox-dark" }).ok).toBe(true)
    expect(validateTheme(light, { id: "beadbox-light" }).ok).toBe(true)
  })

  test("appearances are declared", () => {
    expect(dark.appearance).toBe("dark")
    expect(light.appearance).toBe("light")
  })

  test("every colour key is present in both", () => {
    for (const k of COLOR_KEYS) {
      expect(typeof (dark.colors as Record<string, string>)[k]).toBe("string")
      expect(typeof (light.colors as Record<string, string>)[k]).toBe("string")
    }
  })

  // Regression: the dormant palette had destructiveForeground === destructive.
  test("no foreground equals its own background", () => {
    for (const theme of [dark, light]) {
      const c = theme.colors as Record<string, string>
      for (const pair of [
        ["background", "foreground"], ["card", "cardForeground"],
        ["popover", "popoverForeground"], ["primary", "primaryForeground"],
        ["secondary", "secondaryForeground"], ["muted", "mutedForeground"],
        ["accent", "accentForeground"], ["destructive", "destructiveForeground"],
      ]) {
        expect(c[pair[0]]).not.toBe(c[pair[1]])
      }
    }
  })

  test("core text pairs meet WCAG AA (4.5:1)", () => {
    for (const theme of [dark, light]) {
      const c = theme.colors as Record<string, string>
      expect(ratio(c.background, c.foreground)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(c.primary, c.primaryForeground)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(c.destructive, c.destructiveForeground)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/builtin-themes.test.ts`
Expected: FAIL — cannot resolve `../themes/beadbox-dark.json`.

- [ ] **Step 3: Create `beadbox-dark.json`**

```json
{
  "id": "beadbox-dark",
  "name": "Beadbox Dark",
  "appearance": "dark",
  "colors": {
    "background": "#18181b",
    "foreground": "#f4f4f5",
    "card": "#27272a",
    "cardForeground": "#f4f4f5",
    "popover": "#27272a",
    "popoverForeground": "#f4f4f5",
    "primary": "#22c55e",
    "primaryForeground": "#18181b",
    "secondary": "#3f3f46",
    "secondaryForeground": "#f4f4f5",
    "muted": "#3f3f46",
    "mutedForeground": "#a1a1aa",
    "accent": "#3f3f46",
    "accentForeground": "#f4f4f5",
    "destructive": "#ef4444",
    "destructiveForeground": "#fef2f2",
    "border": "#3f3f46",
    "input": "#3f3f46",
    "ring": "#22c55e"
  }
}
```

- [ ] **Step 4: Create `beadbox-light.json`**

```json
{
  "id": "beadbox-light",
  "name": "Beadbox Light",
  "appearance": "light",
  "colors": {
    "background": "#ffffff",
    "foreground": "#0a0a0a",
    "card": "#ffffff",
    "cardForeground": "#0a0a0a",
    "popover": "#ffffff",
    "popoverForeground": "#0a0a0a",
    "primary": "#15803d",
    "primaryForeground": "#ffffff",
    "secondary": "#f5f5f5",
    "secondaryForeground": "#171717",
    "muted": "#f5f5f5",
    "mutedForeground": "#737373",
    "accent": "#f5f5f5",
    "accentForeground": "#171717",
    "destructive": "#e7000b",
    "destructiveForeground": "#ffffff",
    "border": "#e5e5e5",
    "input": "#e5e5e5",
    "ring": "#16a34a"
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/builtin-themes.test.ts`
Expected: PASS (5 tests).

If `resolveJsonModule` is not already enabled, add `"resolveJsonModule": true`
to `packages/client/tsconfig.json` compilerOptions, then re-run
`bun run typecheck`.

- [ ] **Step 6: Lint and commit**

```bash
bun run check
git add packages/client/src/themes packages/client/src/__tests__/builtin-themes.test.ts
git commit -m "feat(themes): bundled dark and light theme files"
```

---

### Task 3: CSS indirection

**Files:**
- Modify: `packages/client/src/index.css` (the `@theme inline` block; delete `.dark.theme-gray` and `.dark.theme-green`)
- Modify: `packages/client/index.html:2`
- Test: `packages/client/src/__tests__/theme-css.test.ts`

**Interfaces:**
- Consumes: `COLOR_KEYS`, `cssVarName` from Task 1.
- Produces: `--bb-*` custom properties readable at `:root`; `@theme` tokens that dereference them.

**Context:** This is the same `@theme inline` + `var()` form that broke in 0.25.2.
The difference is what sits behind the variable: a single `:root` definition in
hex (spike test T2, passed) rather than three nested scopes with `oklch` (T4).
`inline` is kept because it yields a one-level chain; plain `@theme` would emit
two.

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/__tests__/theme-css.test.ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { COLOR_KEYS, cssVarName } from "../lib/theme-tokens"

const css = readFileSync(join(import.meta.dir, "../index.css"), "utf-8")
const html = readFileSync(join(import.meta.dir, "../../index.html"), "utf-8")

describe("index.css theme indirection", () => {
  test("every colour token dereferences a --bb-* variable", () => {
    for (const key of COLOR_KEYS) {
      const cssKey = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
      expect(css).toContain(`--color-${cssKey}: var(${cssVarName(key)})`)
    }
  })

  test("every --bb-* colour has a :root default", () => {
    for (const key of COLOR_KEYS) {
      expect(css).toMatch(new RegExp(`${cssVarName(key)}:\\s*#[0-9a-fA-F]{6}`))
    }
  })

  test("the superseded nested theme blocks are gone", () => {
    expect(css).not.toContain(".dark.theme-gray")
    expect(css).not.toContain(".dark.theme-green")
  })

  test("no baked literal remains on a --color-* token", () => {
    const themeBlock = css.slice(css.indexOf("@theme inline"))
    const bakedColor = /--color-[a-z-]+:\s*#[0-9a-fA-F]{6}/.exec(themeBlock)
    expect(bakedColor).toBeNull()
  })
})

describe("index.html", () => {
  test("keeps dark as the pre-hydration default and drops theme-gray", () => {
    expect(html).toContain('class="dark"')
    expect(html).not.toContain("theme-gray")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/theme-css.test.ts`
Expected: FAIL — tokens are still baked literals.

- [ ] **Step 3: Rewrite the `@theme inline` block**

Replace each `--color-*`, `--radius-*` and `--font-*` declaration in the
`@theme inline` block with a `var()` reference, and add a `:root` block holding
today's values as defaults. The font and radius comments already in the file
must be preserved.

```css
@theme inline {
  --font-sans: var(--bb-font-sans);
  --font-mono: var(--bb-font-mono);

  --color-background: var(--bb-background);
  --color-foreground: var(--bb-foreground);
  --color-card: var(--bb-card);
  --color-card-foreground: var(--bb-card-foreground);
  --color-popover: var(--bb-popover);
  --color-popover-foreground: var(--bb-popover-foreground);
  --color-primary: var(--bb-primary);
  --color-primary-foreground: var(--bb-primary-foreground);
  --color-secondary: var(--bb-secondary);
  --color-secondary-foreground: var(--bb-secondary-foreground);
  --color-muted: var(--bb-muted);
  --color-muted-foreground: var(--bb-muted-foreground);
  --color-accent: var(--bb-accent);
  --color-accent-foreground: var(--bb-accent-foreground);
  --color-destructive: var(--bb-destructive);
  --color-destructive-foreground: var(--bb-destructive-foreground);
  --color-border: var(--bb-border);
  --color-input: var(--bb-input);
  --color-ring: var(--bb-ring);

  --radius-sm: var(--bb-radius-sm);
  --radius-md: var(--bb-radius-md);
  --radius-lg: var(--bb-radius-lg);
  --radius-xl: var(--bb-radius-xl);
}

/* Baked defaults. These are the 0.25.2 gray literals verbatim, so with JS
   disabled — or the engine bailed via its startup probe — the app renders
   exactly as it does today. The theme engine overwrites these on
   documentElement.style at runtime.
   Single-level and hex-only on purpose: the 0.25.2 failure walked three
   nested scopes with oklch at the root. */
:root {
  --bb-background: #18181b;
  --bb-foreground: #f4f4f5;
  --bb-card: #27272a;
  --bb-card-foreground: #f4f4f5;
  --bb-popover: #27272a;
  --bb-popover-foreground: #f4f4f5;
  --bb-primary: #22c55e;
  --bb-primary-foreground: #18181b;
  --bb-secondary: #3f3f46;
  --bb-secondary-foreground: #f4f4f5;
  --bb-muted: #3f3f46;
  --bb-muted-foreground: #a1a1aa;
  --bb-accent: #3f3f46;
  --bb-accent-foreground: #f4f4f5;
  --bb-destructive: #ef4444;
  --bb-destructive-foreground: #fef2f2;
  --bb-border: #3f3f46;
  --bb-input: #3f3f46;
  --bb-ring: #22c55e;

  --bb-radius-sm: calc(0.625rem - 4px);
  --bb-radius-md: calc(0.625rem - 2px);
  --bb-radius-lg: 0.625rem;
  --bb-radius-xl: calc(0.625rem + 4px);

  --bb-font-sans: 'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --bb-font-mono: 'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

Then delete the `.dark.theme-gray { … }` and `.dark.theme-green { … }` blocks
in their entirety.

- [ ] **Step 4: Update `index.html`**

```html
<html lang="en" class="dark">
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/theme-css.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Verify the emitted CSS matches the one-level expectation**

Run: `cd packages/client && bun run build`
Then: `grep -o 'background-color:var(--bb-background)' dist/assets/*.css | head -1`
Expected: a match — confirming `@theme inline` emits a direct `--bb-*`
reference rather than routing through `--color-*`. If instead you find
`var(--color-background)`, the build is producing two levels of indirection;
record that in the task notes and keep going (it still works, it is just one
level longer than intended).

- [ ] **Step 7: Lint and commit**

```bash
bun run check
git add packages/client/src/index.css packages/client/index.html packages/client/src/__tests__/theme-css.test.ts
git commit -m "feat(themes): route @theme tokens through --bb-* indirection"
```

---

### Task 4: Theme engine — apply and appearance

**Files:**
- Create: `packages/client/src/lib/theme-engine.ts`
- Test: `packages/client/src/__tests__/theme-engine.test.ts`

**Interfaces:**
- Consumes: `Theme`, `cssVarName`, `radiusVarName`, `fontVarName` (Task 1).
- Produces:
  - `applyTheme(theme: Theme, el?: HTMLElement): void`
  - `clearTheme(el?: HTMLElement): void`

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/__tests__/theme-engine.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { applyTheme, clearTheme } from "../lib/theme-engine"
import { COLOR_KEYS, type Theme } from "../lib/theme-tokens"

const theme = (over: Partial<Theme> = {}): Theme => ({
  id: "t", name: "T", appearance: "dark",
  colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, "#102030"])) as Theme["colors"],
  ...over,
})

afterEach(() => {
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
})

describe("applyTheme", () => {
  test("writes every colour token onto the element", () => {
    applyTheme(theme())
    const s = document.documentElement.style
    for (const k of COLOR_KEYS) {
      const name = `--bb-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
      expect(s.getPropertyValue(name)).toBe("#102030")
    }
  })

  test("adds .dark for a dark theme", () => {
    applyTheme(theme({ appearance: "dark" }))
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  test("removes .dark for a light theme", () => {
    document.documentElement.classList.add("dark")
    applyTheme(theme({ appearance: "light" }))
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  test("writes optional radius and font tokens when present", () => {
    applyTheme(theme({ radius: { md: "0.5rem" }, fonts: { sans: "Inter, sans-serif" } }))
    const s = document.documentElement.style
    expect(s.getPropertyValue("--bb-radius-md")).toBe("0.5rem")
    expect(s.getPropertyValue("--bb-font-sans")).toBe("Inter, sans-serif")
  })

  test("omitted radius keys are not written, so the :root default wins", () => {
    applyTheme(theme({ radius: { md: "0.5rem" } }))
    expect(document.documentElement.style.getPropertyValue("--bb-radius-lg")).toBe("")
  })

  // Switching themes must not leak the previous theme's optional tokens.
  test("applying a theme without fonts clears a previous theme's fonts", () => {
    applyTheme(theme({ fonts: { sans: "Inter, sans-serif" } }))
    applyTheme(theme({ id: "u" }))
    expect(document.documentElement.style.getPropertyValue("--bb-font-sans")).toBe("")
  })

  test("clearTheme removes every token it set", () => {
    applyTheme(theme())
    clearTheme()
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe("")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/theme-engine.test.ts`
Expected: FAIL — cannot resolve `../lib/theme-engine`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/client/src/lib/theme-engine.ts
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
  COLOR_KEYS, FONT_KEYS, RADIUS_KEYS,
  cssVarName, fontVarName, radiusVarName, type Theme,
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/theme-engine.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and commit**

```bash
bun run check
git add packages/client/src/lib/theme-engine.ts packages/client/src/__tests__/theme-engine.test.ts
git commit -m "feat(themes): theme engine applies tokens and appearance"
```

---

### Task 5: Startup probe and fallback

**Files:**
- Modify: `packages/client/src/lib/theme-engine.ts`
- Test: `packages/client/src/__tests__/theme-probe.test.ts`

**Interfaces:**
- Consumes: Task 4's module.
- Produces: `probeTokenSupport(el?: HTMLElement): boolean`, `isThemingAvailable(): boolean`

**Context:** This bounds the macOS 13–15 risk the spike could not clear.
The probe detects **non-resolution** only — an unresolvable `var()` falls back
to the property's initial value, which `getComputedStyle` reports literally as
`rgba(0, 0, 0, 0)` for `background-color`. It does **not** detect
*mis*-resolution to a wrong-but-real colour; the hex-only format rule guards
that case instead. Do not describe this probe as proving correctness.

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/__tests__/theme-probe.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { probeTokenSupport } from "../lib/theme-engine"

afterEach(() => {
  document.documentElement.removeAttribute("style")
  document.querySelectorAll("[data-bb-probe]").forEach((n) => n.remove())
})

describe("probeTokenSupport", () => {
  test("returns true when var() indirection resolves", () => {
    expect(probeTokenSupport()).toBe(true)
  })

  test("leaves no probe element behind", () => {
    probeTokenSupport()
    expect(document.querySelectorAll("[data-bb-probe]").length).toBe(0)
  })

  test("does not disturb existing tokens", () => {
    document.documentElement.style.setProperty("--bb-background", "#abcdef")
    probeTokenSupport()
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe("#abcdef")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/theme-probe.test.ts`
Expected: FAIL — `probeTokenSupport` is not exported.

- [ ] **Step 3: Append the probe to `theme-engine.ts`**

```ts
// --- startup probe -------------------------------------------------------
//
// Bounds the risk the 2026-11-13 spike could not clear: it ran on macOS 27
// only, while tauri.conf.json supports 13.0+.
//
// Detects NON-RESOLUTION: a var() the engine cannot walk falls back to the
// property's initial value — `transparent` for background-color, which
// getComputedStyle reports as "rgba(0, 0, 0, 0)".
//
// It does NOT detect MIS-resolution to a wrong-but-real colour. The spike
// showed getComputedStyle returns oklch() verbatim, so computed style cannot
// confirm a resolved value is correct. Hex-only validation guards that case.

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
    const resolved = el.ownerDocument.defaultView
      ?.getComputedStyle(probe)
      .backgroundColor.replace(/\s+/g, " ")
      .trim()
    // Unresolved var() -> initial value -> transparent.
    if (!resolved || resolved === "rgba(0, 0, 0, 0)" || resolved === "transparent") {
      return false
    }
    return resolved === PROBE_RGB || resolved === "rgb(1,2,3)"
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/theme-probe.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint and commit**

```bash
bun run check
git add packages/client/src/lib/theme-engine.ts packages/client/src/__tests__/theme-probe.test.ts
git commit -m "feat(themes): startup probe bounds unresolvable-token risk"
```

---

### Task 6: Status-colour surface derives from the active theme

**Files:**
- Modify: `packages/client/src/lib/status-colors-store.ts` (`currentThemeSurface`, ~line 70)
- Test: `packages/client/src/__tests__/theme-surface.test.ts`

**Interfaces:**
- Consumes: `cssVarName` (Task 1).
- Produces: `currentThemeSurface(el?: Element): string` — unchanged signature, new implementation.

**Context — this is a required fix, not a refactor.** The current body is:

```ts
if (el.classList.contains("theme-gray")) return THEME_SURFACES.gray.card
if (el.classList.contains("theme-green")) return THEME_SURFACES.green.card
return THEME_SURFACES.blue.card
```

Task 3 deletes `.theme-gray`, so every theme would fall through to the **blue**
surface and status colours would be computed against a background no theme uses.

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/__tests__/theme-surface.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { currentThemeSurface } from "../lib/status-colors-store"

afterEach(() => {
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
})

describe("currentThemeSurface", () => {
  test("reads the active theme's card token", () => {
    document.documentElement.style.setProperty("--bb-card", "#27272a")
    expect(currentThemeSurface()).toBe("#27272a")
  })

  test("follows a theme switch", () => {
    document.documentElement.style.setProperty("--bb-card", "#27272a")
    expect(currentThemeSurface()).toBe("#27272a")
    document.documentElement.style.setProperty("--bb-card", "#ffffff")
    expect(currentThemeSurface()).toBe("#ffffff")
  })

  test("falls back to the dark default when no token is set", () => {
    expect(currentThemeSurface()).toBe("#27272a")
  })

  // Regression: the old implementation keyed off .theme-gray / .theme-green,
  // which Task 3 deletes. Those classes must no longer influence the result.
  test("ignores the removed theme-* classes", () => {
    document.documentElement.classList.add("theme-green")
    document.documentElement.style.setProperty("--bb-card", "#ffffff")
    expect(currentThemeSurface()).toBe("#ffffff")
  })
})

// Spec §5 "status-colour integration": the whole reason the design keeps a
// class toggle is that status-colors-mount.tsx observes attributeFilter:
// ["class"]. If applying a theme stopped touching the class, this observer
// would never fire and status colours would stay pinned to the old surface.
describe("appearance change notifies the status-colour observer", () => {
  test("switching dark -> light fires a class MutationObserver", async () => {
    const el = document.documentElement
    // Start from the real initial state: index.html ships class="dark".
    // Without this the toggle is a no-op and no mutation is recorded.
    el.classList.add("dark")

    let fired = 0
    const observer = new MutationObserver(() => { fired++ })
    observer.observe(el, { attributes: true, attributeFilter: ["class"] })

    const { applyTheme } = await import("../lib/theme-engine")
    const { COLOR_KEYS } = await import("../lib/theme-tokens")
    const light = {
      id: "l", name: "L", appearance: "light" as const,
      colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, "#ffffff"])),
    }
    applyTheme(light as Parameters<typeof applyTheme>[0])

    await new Promise((r) => setTimeout(r, 0))
    observer.disconnect()
    expect(fired).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/theme-surface.test.ts`
Expected: FAIL — returns the blue surface constant, not `#27272a`.

- [ ] **Step 3: Replace `currentThemeSurface`**

```ts
/**
 * The card colour of the active theme.
 *
 * Reads the live --bb-card token rather than mapping a theme-* class to a
 * hardcoded table: those classes were removed when runtime theming landed,
 * and with arbitrary user themes there is no fixed set to map. The fallback
 * is the built-in dark card colour, which matches index.css's :root default,
 * so a bailed theme engine still reports the surface actually on screen.
 */
export function currentThemeSurface(el: Element = document.documentElement): string {
  const DEFAULT_CARD = "#27272a"
  const view = el.ownerDocument?.defaultView
  const inline = (el as HTMLElement).style?.getPropertyValue("--bb-card")?.trim()
  if (inline) return inline
  const computed = view?.getComputedStyle(el).getPropertyValue("--bb-card").trim()
  return computed || DEFAULT_CARD
}
```

Remove the now-unused `THEME_SURFACES` entries if nothing else references them;
run `bun run typecheck` to confirm.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/theme-surface.test.ts && bun test src/__tests__/status-colors.test.ts`
Expected: PASS. If `status-colors.test.ts` asserts the old class-based
behaviour, update those assertions to set `--bb-card` instead.

- [ ] **Step 5: Lint and commit**

```bash
bun run check
git add packages/client/src/lib/status-colors-store.ts packages/client/src/__tests__/theme-surface.test.ts
git commit -m "fix(themes): derive status-colour surface from the active theme"
```

---

### Task 7: Theme preference becomes a string id

**Files:**
- Modify: `packages/client/src/lib/local-storage.ts` (lines ~3, ~125-160)
- Modify: `packages/client/src/lib/theme.ts`
- Rewrite: `packages/client/src/__tests__/theme.test.ts`

**Interfaces:**
- Consumes: `Theme` (Task 1), `applyTheme` (Task 4).
- Produces:
  - `type ThemeId = string`
  - `getThemePreference(): ThemeId`
  - `setThemePreference(id: ThemeId): void`
  - `DEFAULT_THEME_ID = "beadbox-dark"`
  - `applyThemeClass(el: HTMLElement, appearance: "dark" | "light"): void`

**Context:** `theme.test.ts` currently asserts `AVAILABLE_THEMES` equals
`["gray"]` and that blue/green downgrade to gray. Those assertions encode the
limitation being removed; leaving them green would mean the fix had not landed.
The one behaviour worth keeping is that an unrenderable stored preference is
**not rewritten** — uninstall a theme and reinstall it and the user's choice
returns.

- [ ] **Step 1: Rewrite the test file**

```ts
// packages/client/src/__tests__/theme.test.ts
// Rewritten for runtime themes. The previous version asserted gray-only
// rendering, which was the 0.25.2 limitation this feature removes.
import { afterEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_THEME_ID, getThemePreference, setThemePreference,
} from "../lib/local-storage"
import { applyThemeClass } from "../lib/theme"

afterEach(() => {
  localStorage.clear()
  document.documentElement.className = ""
})

describe("theme preference", () => {
  test("defaults to the built-in dark theme", () => {
    expect(getThemePreference()).toBe(DEFAULT_THEME_ID)
  })

  test("round-trips an arbitrary custom theme id", () => {
    setThemePreference("nord")
    expect(getThemePreference()).toBe("nord")
  })

  test("a preference for a theme that is not installed is preserved, not rewritten", () => {
    setThemePreference("nord")
    expect(localStorage.getItem("beads-theme")).toBe("nord")
    expect(getThemePreference()).toBe("nord")
  })

  test("rejects a syntactically invalid id and falls back", () => {
    localStorage.setItem("beads-theme", "../../etc/passwd")
    expect(getThemePreference()).toBe(DEFAULT_THEME_ID)
  })
})

describe("applyThemeClass", () => {
  test("dark appearance adds .dark", () => {
    applyThemeClass(document.documentElement, "dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  test("light appearance removes .dark", () => {
    document.documentElement.classList.add("dark")
    applyThemeClass(document.documentElement, "light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  test("no longer writes theme-* classes", () => {
    applyThemeClass(document.documentElement, "dark")
    expect(document.documentElement.className).toBe("dark")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/theme.test.ts`
Expected: FAIL — `DEFAULT_THEME_ID` is not exported.

- [ ] **Step 3: Update `local-storage.ts`**

Replace the `ThemeVariant` union, `VALID_THEMES`, `AVAILABLE_THEMES` and
`effectiveTheme` with:

```ts
export type ThemeId = string

export const DEFAULT_THEME_ID = "beadbox-dark"

const THEME_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * The stored theme id, or the built-in dark theme.
 *
 * A syntactically valid id for a theme that is not currently installed is
 * returned as-is and left in storage: a user who removes a theme file and
 * puts it back should get their choice returned rather than silently reset.
 * Whether the id resolves to an installed theme is theme-source's concern.
 */
export function getThemePreference(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored && THEME_ID_RE.test(stored)) return stored
  } catch {
    // localStorage unavailable (private mode, disabled storage).
  }
  return DEFAULT_THEME_ID
}

export function setThemePreference(id: ThemeId): void {
  if (!THEME_ID_RE.test(id)) return
  try {
    localStorage.setItem(THEME_KEY, id)
  } catch {
    // Non-fatal: the theme still applies for this session.
  }
}
```

Keep `THEME_KEY = "beads-theme"` unchanged so existing preferences survive.
Remove `ThemeVariant` and update its importers (`bun run typecheck` lists them).

- [ ] **Step 4: Update `theme.ts`**

```ts
// packages/client/src/lib/theme.ts
// Appearance-only: the .dark class drives Tailwind's dark: variants and the
// status-colour MutationObserver. Colour tokens are applied separately by
// theme-engine.applyTheme.
import type { Appearance } from "./theme-tokens"

export function applyThemeClass(el: HTMLElement, appearance: Appearance): void {
  el.classList.toggle("dark", appearance === "dark")
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd packages/client && bun test src/__tests__/theme.test.ts && bun run typecheck`
Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 6: Lint and commit**

```bash
bun run check
git add packages/client/src/lib/local-storage.ts packages/client/src/lib/theme.ts packages/client/src/__tests__/theme.test.ts
git commit -m "feat(themes): theme preference accepts arbitrary theme ids"
```

---

### Task 8: Sidecar reads theme files from disk

**Files:**
- Create: `packages/server/src/lib/theme-files.ts`
- Test: `packages/server/src/__tests__/theme-files.test.ts`

**Interfaces:**
- Consumes: `validateTheme` (Task 1) — import across the workspace boundary the
  same way `packages/client` already imports `@beadbox/server` types.
- Produces:
  - `getThemesDir(): string`
  - `type ThemeEntry = { id: string; name: string; appearance: "dark"|"light"; source: "user"; error?: string }`
  - `listThemeFiles(): Promise<ThemeEntry[]>`
  - `readThemeFile(id: string): Promise<{ ok: true; theme: Theme } | { ok: false; error: string }>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/__tests__/theme-files.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getThemesDir, listThemeFiles, readThemeFile } from "../lib/theme-files"

let dir: string
const COLORS = {
  background: "#18181b", foreground: "#f4f4f5", card: "#27272a",
  cardForeground: "#f4f4f5", popover: "#27272a", popoverForeground: "#f4f4f5",
  primary: "#22c55e", primaryForeground: "#18181b", secondary: "#3f3f46",
  secondaryForeground: "#f4f4f5", muted: "#3f3f46", mutedForeground: "#a1a1aa",
  accent: "#3f3f46", accentForeground: "#f4f4f5", destructive: "#ef4444",
  destructiveForeground: "#fef2f2", border: "#3f3f46", input: "#3f3f46",
  ring: "#22c55e",
}
const good = (id: string) =>
  JSON.stringify({ id, name: id, appearance: "dark", colors: COLORS })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-themes-"))
  process.env.BEADBOX_THEMES_PATH = dir
})
afterEach(async () => {
  delete process.env.BEADBOX_THEMES_PATH
  await rm(dir, { recursive: true, force: true })
})

describe("getThemesDir", () => {
  test("honours BEADBOX_THEMES_PATH", () => {
    expect(getThemesDir()).toBe(dir)
  })
})

describe("listThemeFiles", () => {
  test("returns an empty list when the directory does not exist", async () => {
    process.env.BEADBOX_THEMES_PATH = join(dir, "nope")
    expect(await listThemeFiles()).toEqual([])
  })

  test("lists valid themes with metadata only", async () => {
    await writeFile(join(dir, "nord.json"), good("nord"))
    const list = await listThemeFiles()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe("nord")
    expect(list[0].source).toBe("user")
    expect((list[0] as Record<string, unknown>).colors).toBeUndefined()
  })

  test("reports an invalid theme instead of dropping it", async () => {
    await writeFile(join(dir, "bad.json"), JSON.stringify({ id: "bad" }))
    const list = await listThemeFiles()
    expect(list).toHaveLength(1)
    expect(list[0].error).toBeTruthy()
  })

  test("a corrupt file is reported, not fatal", async () => {
    await writeFile(join(dir, "broken.json"), "{ not json")
    await writeFile(join(dir, "nord.json"), good("nord"))
    const list = await listThemeFiles()
    expect(list).toHaveLength(2)
    expect(list.find((e) => e.id === "broken")?.error).toContain("JSON")
    expect(list.find((e) => e.id === "nord")?.error).toBeUndefined()
  })

  test("ignores non-json files and subdirectories", async () => {
    await writeFile(join(dir, "notes.txt"), "hello")
    await mkdir(join(dir, "sub"))
    await writeFile(join(dir, "nord.json"), good("nord"))
    expect(await listThemeFiles()).toHaveLength(1)
  })

  test("rejects a file whose id does not match its stem", async () => {
    await writeFile(join(dir, "arctic.json"), good("nord"))
    const list = await listThemeFiles()
    expect(list[0].error).toContain("filename stem")
  })
})

describe("readThemeFile", () => {
  test("returns the full theme for a valid id", async () => {
    await writeFile(join(dir, "nord.json"), good("nord"))
    const r = await readThemeFile("nord")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theme.colors.background).toBe("#18181b")
  })

  test("refuses a path-traversal id without touching the filesystem", async () => {
    const r = await readThemeFile("../../etc/passwd")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("invalid")
  })

  test("reports a missing theme", async () => {
    const r = await readThemeFile("absent")
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test src/__tests__/theme-files.test.ts`
Expected: FAIL — cannot resolve `../lib/theme-files`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/src/lib/theme-files.ts
// Reads user theme files from ~/.beadbox/themes/*.json.
//
// Location mirrors getBeadboxRegistryPath() in workspace-registry.ts:
// same ~/.beadbox directory, same env-var override for test isolation.
// Reading happens here, in the sidecar, so no Tauri fs: capability is needed
// — the webview never touches the filesystem.

import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, basename } from "node:path"

import { validateTheme } from "@beadbox/client/lib/theme-validate"
import type { Theme } from "@beadbox/client/lib/theme-tokens"

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface ThemeEntry {
  id: string
  name: string
  appearance: "dark" | "light"
  source: "user"
  error?: string
}

/** Respects BEADBOX_THEMES_PATH for test isolation. */
export function getThemesDir(): string {
  return process.env.BEADBOX_THEMES_PATH || join(homedir(), ".beadbox", "themes")
}

export async function listThemeFiles(): Promise<ThemeEntry[]> {
  let names: string[]
  try {
    names = await readdir(getThemesDir())
  } catch {
    // No themes directory yet is the normal first-run state, not an error.
    return []
  }

  const entries: ThemeEntry[] = []
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue
    const id = basename(name, ".json")
    if (!ID_RE.test(id)) continue

    let raw: string
    try {
      raw = await readFile(join(getThemesDir(), name), "utf-8")
    } catch {
      continue // a subdirectory or an unreadable entry
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      entries.push({
        id, name: id, appearance: "dark", source: "user",
        error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }

    const result = validateTheme(parsed, { id })
    if (!result.ok) {
      entries.push({ id, name: id, appearance: "dark", source: "user", error: result.error })
      continue
    }
    // Metadata only — the picker should not pay for every theme's tokens.
    entries.push({
      id: result.theme.id,
      name: result.theme.name,
      appearance: result.theme.appearance,
      source: "user",
    })
  }
  return entries
}

export async function readThemeFile(
  id: string,
): Promise<{ ok: true; theme: Theme } | { ok: false; error: string }> {
  // Validate before building a path so a traversal attempt never reaches fs.
  if (!ID_RE.test(id)) return { ok: false, error: `invalid theme id "${id}"` }

  let raw: string
  try {
    raw = await readFile(join(getThemesDir(), `${id}.json`), "utf-8")
  } catch {
    return { ok: false, error: `theme "${id}" not found` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  return validateTheme(parsed, { id })
}
```

If `@beadbox/client/...` is not an importable specifier from the server package,
move `theme-tokens.ts` and `theme-validate.ts` into a location both packages
already share and update both import sites. Check `packages/client/package.json`
`name` and `exports` first; `packages/server` already imports client types
elsewhere, so follow whatever pattern is in place.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bun test src/__tests__/theme-files.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Lint and commit**

```bash
bun run check
git add packages/server/src/lib/theme-files.ts packages/server/src/__tests__/theme-files.test.ts
git commit -m "feat(themes): sidecar reads user theme files from ~/.beadbox/themes"
```

---

### Task 9: `themes` kkrpc namespace

**Files:**
- Create: `packages/server/src/handlers/themes.ts`
- Modify: `packages/server/src/handlers/index.ts`
- Test: `packages/server/src/__tests__/themes-handler.test.ts`

**Interfaces:**
- Consumes: `listThemeFiles`, `readThemeFile` (Task 8).
- Produces: `rpc.themes.list()`, `rpc.themes.get(id)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/__tests__/themes-handler.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handlers } from "../handlers"
import * as themes from "../handlers/themes"

let dir: string
const COLORS = {
  background: "#18181b", foreground: "#f4f4f5", card: "#27272a",
  cardForeground: "#f4f4f5", popover: "#27272a", popoverForeground: "#f4f4f5",
  primary: "#22c55e", primaryForeground: "#18181b", secondary: "#3f3f46",
  secondaryForeground: "#f4f4f5", muted: "#3f3f46", mutedForeground: "#a1a1aa",
  accent: "#3f3f46", accentForeground: "#f4f4f5", destructive: "#ef4444",
  destructiveForeground: "#fef2f2", border: "#3f3f46", input: "#3f3f46",
  ring: "#22c55e",
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-themes-h-"))
  process.env.BEADBOX_THEMES_PATH = dir
})
afterEach(async () => {
  delete process.env.BEADBOX_THEMES_PATH
  await rm(dir, { recursive: true, force: true })
})

describe("themes handler", () => {
  test("is registered in the handler registry", () => {
    expect(handlers.themes).toBeDefined()
    expect(typeof handlers.themes.list).toBe("function")
    expect(typeof handlers.themes.get).toBe("function")
  })

  test("list returns user themes", async () => {
    await writeFile(
      join(dir, "nord.json"),
      JSON.stringify({ id: "nord", name: "Nord", appearance: "dark", colors: COLORS }),
    )
    const list = await themes.list()
    expect(list.map((e) => e.id)).toContain("nord")
  })

  test("get returns the full theme", async () => {
    await writeFile(
      join(dir, "nord.json"),
      JSON.stringify({ id: "nord", name: "Nord", appearance: "dark", colors: COLORS }),
    )
    const t = await themes.get("nord")
    expect(t?.colors.background).toBe("#18181b")
  })

  test("get returns null for an unknown theme rather than throwing", async () => {
    expect(await themes.get("absent")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test src/__tests__/themes-handler.test.ts`
Expected: FAIL — `handlers.themes` is undefined.

- [ ] **Step 3: Write the handler**

```ts
// packages/server/src/handlers/themes.ts
// kkrpc namespace for user-supplied themes. Metadata and full-token reads
// are separate calls so the picker does not load every theme's tokens.

import { listThemeFiles, readThemeFile, type ThemeEntry } from "../lib/theme-files"
import type { Theme } from "@beadbox/client/lib/theme-tokens"

export async function list(): Promise<ThemeEntry[]> {
  return listThemeFiles()
}

/** The full theme, or null when it is missing or invalid. */
export async function get(id: string): Promise<Theme | null> {
  const result = await readThemeFile(id)
  return result.ok ? result.theme : null
}

export type { ThemeEntry }
```

- [ ] **Step 4: Register the namespace**

In `packages/server/src/handlers/index.ts`, add the import alongside the others
(alphabetical, after `system`):

```ts
import * as themes from "./themes"
```

and the registry entry (after `system`):

```ts
  themes: wrapNamespace(themes, "themes"),
```

`wrapNamespace` applies the standard 30s handler timeout; theme reads are local
file IO and well inside it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/server && bun test src/__tests__/themes-handler.test.ts && bun test src/__tests__/_import-sweep.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
bun run check
git add packages/server/src/handlers/themes.ts packages/server/src/handlers/index.ts packages/server/src/__tests__/themes-handler.test.ts
git commit -m "feat(themes): expose themes.list and themes.get over kkrpc"
```

---

### Task 10: Client theme source

**Files:**
- Create: `packages/client/src/lib/theme-source.ts`
- Test: `packages/client/src/__tests__/theme-source.test.ts`

**Interfaces:**
- Consumes: built-in JSON (Task 2), `rpc` (`packages/client/src/lib/rpc.ts`), `validateTheme` (Task 1).
- Produces:
  - `BUILTIN_THEMES: readonly Theme[]`
  - `listThemes(): Promise<ThemeEntry[]>` — built-ins first, then user themes
  - `loadTheme(id: string): Promise<Theme>` — falls back to the built-in dark theme

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/__tests__/theme-source.test.ts
import { afterEach, describe, expect, mock, test } from "bun:test"
import { _resetRpc, _setRpc } from "../lib/rpc"
import { BUILTIN_THEMES, listThemes, loadTheme } from "../lib/theme-source"

afterEach(() => { _resetRpc() })

const stubRpc = (impl: Record<string, unknown>) =>
  _setRpc({ themes: impl } as unknown as Parameters<typeof _setRpc>[0])

describe("BUILTIN_THEMES", () => {
  test("ships dark and light", () => {
    expect(BUILTIN_THEMES.map((t) => t.id).sort()).toEqual(["beadbox-dark", "beadbox-light"])
  })
})

describe("listThemes", () => {
  test("built-ins come first, then user themes", async () => {
    stubRpc({ list: mock(async () => [{ id: "nord", name: "Nord", appearance: "dark", source: "user" }]) })
    const list = await listThemes()
    expect(list.slice(0, 2).map((e) => e.id)).toEqual(["beadbox-dark", "beadbox-light"])
    expect(list.map((e) => e.id)).toContain("nord")
  })

  test("returns built-ins only when the sidecar is unavailable", async () => {
    stubRpc({ list: mock(async () => { throw new Error("RpcUnavailable") }) })
    const list = await listThemes()
    expect(list.map((e) => e.id)).toEqual(["beadbox-dark", "beadbox-light"])
  })

  test("a user theme cannot shadow a built-in id", async () => {
    stubRpc({ list: mock(async () => [{ id: "beadbox-dark", name: "Hijack", appearance: "light", source: "user" }]) })
    const list = await listThemes()
    expect(list.filter((e) => e.id === "beadbox-dark")).toHaveLength(1)
    expect(list.find((e) => e.id === "beadbox-dark")?.name).toBe("Beadbox Dark")
  })
})

describe("loadTheme", () => {
  test("returns a built-in without calling the sidecar", async () => {
    const list = mock(async () => [])
    stubRpc({ list, get: mock(async () => null) })
    const t = await loadTheme("beadbox-light")
    expect(t.appearance).toBe("light")
  })

  test("falls back to the built-in dark theme when a theme is missing", async () => {
    stubRpc({ get: mock(async () => null) })
    const t = await loadTheme("absent")
    expect(t.id).toBe("beadbox-dark")
  })

  test("falls back when the sidecar returns an invalid theme", async () => {
    stubRpc({ get: mock(async () => ({ id: "bad", name: "Bad", appearance: "dark", colors: {} })) })
    const t = await loadTheme("bad")
    expect(t.id).toBe("beadbox-dark")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/theme-source.test.ts`
Expected: FAIL — cannot resolve `../lib/theme-source`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/client/src/lib/theme-source.ts
// Merges the bundled built-in themes with whatever the sidecar finds on disk.
//
// Built-ins win on id collision so a user file named beadbox-dark.json cannot
// replace the theme the app falls back to. In browser/stub mode rpc throws
// RpcUnavailableError; that degrades to built-ins only rather than failing.

import darkJson from "../themes/beadbox-dark.json"
import lightJson from "../themes/beadbox-light.json"
import { rpc } from "./rpc"
import type { Theme } from "./theme-tokens"
import { validateTheme } from "./theme-validate"

/**
 * Widens the sidecar's ThemeEntry (Task 8), whose `source` is always "user",
 * to also describe bundled themes. Structurally compatible, so a server entry
 * assigns to this without conversion. Keep the two in sync: adding a field
 * here that the server does not send will be `undefined` at runtime.
 */
export interface ThemeEntry {
  id: string
  name: string
  appearance: "dark" | "light"
  source: "builtin" | "user"
  error?: string
}

export const BUILTIN_THEMES: readonly Theme[] = [
  darkJson as Theme,
  lightJson as Theme,
]

export const FALLBACK_THEME: Theme = darkJson as Theme

function entryOf(t: Theme): ThemeEntry {
  return { id: t.id, name: t.name, appearance: t.appearance, source: "builtin" }
}

export async function listThemes(): Promise<ThemeEntry[]> {
  const builtins = BUILTIN_THEMES.map(entryOf)
  const builtinIds = new Set(builtins.map((e) => e.id))
  let user: ThemeEntry[] = []
  try {
    const raw = (await rpc.themes.list()) as ThemeEntry[]
    user = raw.filter((e) => !builtinIds.has(e.id))
  } catch {
    // Sidecar unavailable (browser mode, or not yet connected).
    user = []
  }
  return [...builtins, ...user]
}

export async function loadTheme(id: string): Promise<Theme> {
  const builtin = BUILTIN_THEMES.find((t) => t.id === id)
  if (builtin) return builtin
  try {
    const raw = await rpc.themes.get(id)
    if (raw) {
      const result = validateTheme(raw, { id })
      if (result.ok) return result.theme
    }
  } catch {
    // fall through
  }
  return FALLBACK_THEME
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/theme-source.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and commit**

```bash
bun run check
git add packages/client/src/lib/theme-source.ts packages/client/src/__tests__/theme-source.test.ts
git commit -m "feat(themes): merge built-in and user themes on the client"
```

---

### Task 11: Wire theming into app startup

**Files:**
- Create: `packages/client/src/hooks/use-theme.ts`
- Modify: `packages/client/src/routes/__root.tsx`
- Test: `packages/client/src/__tests__/use-theme.test.tsx`

**Interfaces:**
- Consumes: `applyTheme`, `isThemingAvailable` (Tasks 4-5), `loadTheme` (Task 10), `getThemePreference`/`setThemePreference` (Task 7).
- Produces: `useTheme(): { themeId: string; setTheme(id: string): void; available: boolean }`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/client/src/__tests__/use-theme.test.tsx
import { afterEach, describe, expect, test } from "bun:test"
import { render, waitFor } from "@testing-library/react"
import { useTheme } from "../hooks/use-theme"

function Probe() {
  const { themeId, available } = useTheme()
  return <div data-testid="out">{`${themeId}:${available}`}</div>
}

afterEach(() => {
  localStorage.clear()
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
})

describe("useTheme", () => {
  test("applies the stored theme on mount", async () => {
    localStorage.setItem("beads-theme", "beadbox-light")
    const { getByTestId } = render(<Probe />)
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-light:true")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe("#ffffff")
  })

  test("defaults to the dark theme with no stored preference", async () => {
    const { getByTestId } = render(<Probe />)
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/use-theme.test.tsx`
Expected: FAIL — cannot resolve `../hooks/use-theme`.

- [ ] **Step 3: Write the hook**

```ts
// packages/client/src/hooks/use-theme.ts
// Owns the active theme for the session: reads the stored preference,
// loads the theme, applies it, and persists changes.
//
// If the startup probe says token indirection does not resolve on this
// engine, nothing is applied and the app renders from index.css's baked
// :root literals — today's appearance. `available` is false so the picker
// can explain why switching is unavailable instead of silently doing
// nothing.

import { useCallback, useEffect, useState } from "react"

import { getThemePreference, setThemePreference } from "../lib/local-storage"
import { applyTheme, isThemingAvailable } from "../lib/theme-engine"
import { loadTheme } from "../lib/theme-source"

export function useTheme(): {
  themeId: string
  setTheme: (id: string) => void
  available: boolean
} {
  const [themeId, setThemeId] = useState(() => getThemePreference())
  const [available] = useState(() => isThemingAvailable())

  useEffect(() => {
    if (!available) return
    let cancelled = false
    void loadTheme(themeId).then((theme) => {
      if (!cancelled) applyTheme(theme)
    })
    return () => {
      cancelled = true
    }
  }, [themeId, available])

  const setTheme = useCallback((id: string) => {
    setThemePreference(id)
    setThemeId(id)
  }, [])

  return { themeId, setTheme, available }
}
```

- [ ] **Step 4: Mount it in the root route**

In `packages/client/src/routes/__root.tsx`, add the import and call the hook in
the root component body. It must sit above any early return so it runs on every
render path; it needs no return value, because applying the theme is the side
effect.

```tsx
import { useTheme } from "../hooks/use-theme"

// …inside the root component, as its first statement:
function RootComponent() {
  // Applies the stored theme to <html>. Must run before any early return
  // so a loading or error branch is themed too.
  useTheme()

  // …existing body unchanged
}
```

If the root component is declared with a different name or as an inline arrow in
`createRootRoute({ component: … })`, add the `useTheme()` call as the first
statement of whatever function renders the tree.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/use-theme.test.tsx && bun test`
Expected: PASS — and the whole client suite still green.

- [ ] **Step 6: Lint and commit**

```bash
bun run check
git add packages/client/src/hooks/use-theme.ts packages/client/src/routes/__root.tsx packages/client/src/__tests__/use-theme.test.tsx
git commit -m "feat(themes): apply the stored theme at app startup"
```

---

### Task 12: Theme picker UI

**Files:**
- Create: `packages/client/src/components/theme-section.tsx`
- Modify: the settings surface that renders `StatusColorsSection` (find with `grep -rn "StatusColorsSection" packages/client/src --include=*.tsx`)
- Test: `packages/client/src/__tests__/theme-section.test.tsx`

**Interfaces:**
- Consumes: `useTheme` (Task 11), `listThemes` (Task 10).
- Produces: `<ThemeSection />`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/client/src/__tests__/theme-section.test.tsx
import { afterEach, describe, expect, mock, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import { _resetRpc, _setRpc } from "../lib/rpc"
import { ThemeSection } from "../components/theme-section"

afterEach(() => {
  _resetRpc()
  localStorage.clear()
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
})

const stub = (list: unknown[]) =>
  _setRpc({ themes: { list: mock(async () => list), get: mock(async () => null) } } as never)

describe("ThemeSection", () => {
  test("lists built-in themes", async () => {
    stub([])
    render(<ThemeSection />)
    await waitFor(() => {
      expect(screen.getByText("Beadbox Dark")).toBeDefined()
      expect(screen.getByText("Beadbox Light")).toBeDefined()
    })
  })

  test("shows a user theme's validation error instead of hiding it", async () => {
    stub([{ id: "bad", name: "bad", appearance: "dark", source: "user", error: "colors.ring is missing" }])
    render(<ThemeSection />)
    await waitFor(() => {
      expect(screen.getByText(/colors.ring is missing/)).toBeDefined()
    })
  })

  test("explains when theming is unavailable on this engine", async () => {
    stub([])
    // Force the probe to report unavailable.
    const { __resetProbeCache } = await import("../lib/theme-engine")
    __resetProbeCache()
    const doc = document.documentElement
    const original = window.getComputedStyle
    // @ts-expect-error test seam
    window.getComputedStyle = () => ({ backgroundColor: "rgba(0, 0, 0, 0)", getPropertyValue: () => "" })
    render(<ThemeSection />)
    await waitFor(() => {
      expect(screen.getByText(/not supported/i)).toBeDefined()
    })
    window.getComputedStyle = original
    void doc
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/theme-section.test.tsx`
Expected: FAIL — cannot resolve `../components/theme-section`.

- [ ] **Step 3: Write the component**

```tsx
// packages/client/src/components/theme-section.tsx
// Settings section for picking a theme. Mirrors StatusColorsSection's
// structure so the two read as one settings surface.

import { useQuery } from "@tanstack/react-query"

import { useTheme } from "../hooks/use-theme"
import { listThemes, type ThemeEntry } from "../lib/theme-source"

export const themesQueryKey = ["themes"] as const

export function ThemeSection() {
  const { themeId, setTheme, available } = useTheme()
  const { data } = useQuery({ queryKey: themesQueryKey, queryFn: listThemes })
  const themes: ThemeEntry[] = data ?? []

  if (!available) {
    return (
      <section>
        <h3 className="text-sm font-medium">Theme</h3>
        <p className="text-sm text-muted-foreground">
          Theming is not supported on this system's web engine, so Beadbox is
          using its built-in appearance.
        </p>
      </section>
    )
  }

  return (
    <section>
      <h3 className="text-sm font-medium">Theme</h3>
      <ul className="mt-2 space-y-1">
        {themes.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              disabled={Boolean(t.error)}
              aria-current={t.id === themeId}
              onClick={() => setTheme(t.id)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm hover:bg-accent disabled:opacity-60"
            >
              <span>{t.name}</span>
              {t.error ? (
                <span className="text-xs text-destructive">{t.error}</span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t.source === "builtin" ? "built-in" : t.appearance}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Add your own by dropping a .json file into ~/.beadbox/themes
      </p>
    </section>
  )
}
```

- [ ] **Step 4: Render it in settings**

Add `<ThemeSection />` immediately above `<StatusColorsSection …/>` in the
settings surface located in Step 1's grep. Theme choice is app-level and status
colours are workspace-level, so theme comes first.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/theme-section.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Lint and commit**

```bash
bun run check
git add packages/client/src/components/theme-section.tsx packages/client/src/__tests__/theme-section.test.tsx
git commit -m "feat(themes): theme picker in settings"
```

---

### Task 13: Hot reload on file change

**Files:**
- Modify: `packages/server/src/lib/theme-files.ts` (add `watchThemes`)
- Modify: `packages/server/src/handlers/themes.ts` (add `startWatch`/`stopWatch`)
- Modify: `packages/client/src/hooks/use-theme.ts` (invalidate + re-apply)
- Test: `packages/server/src/__tests__/theme-watch.test.ts`

**Interfaces:**
- Consumes: Tasks 8-11.
- Produces: `watchThemes(onChange: () => void): () => void`; `themes.startWatch()`, `themes.stopWatch()`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/__tests__/theme-watch.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchThemes } from "../lib/theme-files"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-themes-w-"))
  process.env.BEADBOX_THEMES_PATH = dir
})
afterEach(async () => {
  delete process.env.BEADBOX_THEMES_PATH
  await rm(dir, { recursive: true, force: true })
})

describe("watchThemes", () => {
  test("fires when a theme file is written", async () => {
    let fired = 0
    const stop = watchThemes(() => { fired++ })
    await writeFile(join(dir, "nord.json"), "{}")
    await new Promise((r) => setTimeout(r, 300))
    stop()
    expect(fired).toBeGreaterThan(0)
  })

  test("returns a no-op stop when the directory does not exist", () => {
    process.env.BEADBOX_THEMES_PATH = join(dir, "nope")
    const stop = watchThemes(() => {})
    expect(() => stop()).not.toThrow()
  })

  test("stop() silences further events", async () => {
    let fired = 0
    const stop = watchThemes(() => { fired++ })
    stop()
    await writeFile(join(dir, "nord.json"), "{}")
    await new Promise((r) => setTimeout(r, 300))
    expect(fired).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test src/__tests__/theme-watch.test.ts`
Expected: FAIL — `watchThemes` is not exported.

- [ ] **Step 3: Add the watcher**

```ts
// Append to packages/server/src/lib/theme-files.ts
import { watch, type FSWatcher } from "node:fs"

/**
 * Watch the themes directory. Editors write in several steps (temp file,
 * rename, chmod), so changes are debounced into one callback.
 * Returns a stop function; a missing directory yields a no-op.
 */
export function watchThemes(onChange: () => void): () => void {
  let watcher: FSWatcher
  try {
    watcher = watch(getThemesDir(), { persistent: false })
  } catch {
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  watcher.on("change", () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, 120)
  })
  watcher.on("rename", () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, 120)
  })
  watcher.on("error", () => { /* a vanished directory is not fatal */ })
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    watcher.close()
  }
}
```

- [ ] **Step 4: Expose it on the handler**

```ts
// Append to packages/server/src/handlers/themes.ts
import { watchThemes } from "../lib/theme-files"

let stopWatcher: (() => void) | null = null

/**
 * Emits a themes-changed line on the same stderr channel subscribe.ts uses,
 * so hot reload needs no new transport.
 */
export async function startWatch(): Promise<void> {
  stopWatcher?.()
  stopWatcher = watchThemes(() => {
    process.stderr.write(`[THEMES:changed] ${JSON.stringify({ at: Date.now() })}\n`)
  })
}

export async function stopWatch(): Promise<void> {
  stopWatcher?.()
  stopWatcher = null
}
```

- [ ] **Step 5: Invalidate on the client**

First locate how the client consumes sidecar stderr events:
`grep -rn "SUBSCRIPTION:" packages/client/src`. That call site exposes the
event-stream subscription helper; the code below calls it `onSidecarEvent` —
substitute the real export name.

Add to `packages/client/src/hooks/use-theme.ts`:

```ts
import { useQueryClient } from "@tanstack/react-query"
import { rpc } from "../lib/rpc"
import { themesQueryKey } from "../components/theme-section"
// Substitute the real helper found by the grep above:
import { onSidecarEvent } from "../lib/sidecar-events"

// …inside useTheme(), after the existing effect:
const queryClient = useQueryClient()

useEffect(() => {
  if (!available) return
  let disposed = false

  // Browser/stub mode throws RpcUnavailableError; hot reload is simply
  // absent there, which is not an error worth surfacing.
  void rpc.themes.startWatch().catch(() => {})

  const off = onSidecarEvent((line: string) => {
    if (disposed || !line.startsWith("[THEMES:changed]")) return
    void queryClient.invalidateQueries({ queryKey: themesQueryKey })
    void loadTheme(themeId).then((theme) => {
      if (!disposed) applyTheme(theme)
    })
  })

  return () => {
    disposed = true
    off()
    void rpc.themes.stopWatch().catch(() => {})
  }
}, [available, themeId, queryClient])
```

Importing `themesQueryKey` from `theme-section.tsx` creates a hook→component
dependency. If `bun run typecheck` reports a cycle, move `themesQueryKey` into
`lib/theme-source.ts` and import it from there in both places.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/server && bun test src/__tests__/theme-watch.test.ts && cd ../client && bun test`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
bun run check
git add packages/server/src/lib/theme-files.ts packages/server/src/handlers/themes.ts packages/client/src/hooks/use-theme.ts packages/server/src/__tests__/theme-watch.test.ts
git commit -m "feat(themes): hot-reload themes when files change on disk"
```

---

### Task 14: End-to-end light theme check

**Files:**
- Create: `e2e/headless/theme-switch.spec.ts`
- Test: itself

**Interfaces:**
- Consumes: the whole feature.
- Produces: nothing.

**Context:** Model this on `e2e/headless/status-colors.spec.ts` — read it first
for the harness's setup and selectors; the code below assumes its conventions.

- [ ] **Step 1: Write the spec**

```ts
// e2e/headless/theme-switch.spec.ts
import { expect, test } from "@playwright/test"

// Mirrors the setup in status-colors.spec.ts.
test.describe("theme switching", () => {
  test("switching to light flips appearance and recolours the surface", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator("html")).toHaveClass(/dark/)

    const darkBg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    )

    await page.evaluate(() => {
      localStorage.setItem("beads-theme", "beadbox-light")
    })
    await page.reload()

    await expect(page.locator("html")).not.toHaveClass(/dark/)

    const lightBg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    )
    expect(lightBg).not.toBe(darkBg)

    // The regression that motivated the hybrid design: status colours must
    // follow the appearance change, not stay pinned to the dark surface.
    const surface = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--bb-card").trim(),
    )
    expect(surface).toBe("#ffffff")
  })

  test("body text stays readable against the background in light mode", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => localStorage.setItem("beads-theme", "beadbox-light"))
    await page.reload()

    const { bg, fg } = await page.evaluate(() => {
      const s = getComputedStyle(document.body)
      return { bg: s.backgroundColor, fg: s.color }
    })
    expect(bg).not.toBe(fg)
  })
})
```

- [ ] **Step 2: Run the spec**

Run: `bun run test:e2e -- theme-switch`
Expected: PASS. If the harness needs a workspace fixture, copy the
`test.beforeEach` block from `status-colors.spec.ts`.

- [ ] **Step 3: Run the full suite**

Run: `bun run test && bun run quality:check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
bun run check
git add e2e/headless/theme-switch.spec.ts
git commit -m "test(themes): e2e coverage for light theme switching"
```

---

## Not covered by any task, by design

- **Rendering on macOS 13–15.** Cannot be tested from this environment. Task 5's
  probe is the mitigation; the spec says so plainly rather than implying
  coverage that does not exist.
- **Whether a valid theme is legible.** Syntax is validated, taste is not
  (spec §4.3). Task 2 asserts contrast for the *built-in* themes only.
- **Per-workspace themes, theme sharing/download, theming the Rust loading
  screen.** Spec "Out of scope".
