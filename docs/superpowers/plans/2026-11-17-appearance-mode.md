# Appearance Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose an appearance mode — permanently dark, permanently light, or follow the system — and assign a theme to each of the dark and light slots.

**Architecture:** Three persisted values (`mode`, `darkThemeId`, `lightThemeId`) replace the single stored theme id. The effective appearance is derived from `mode` plus `prefers-color-scheme`, and it — not the theme's own `appearance` field — drives the `.dark` class. Each theme is offered only for the slot matching its declared `appearance`, so the class and the tokens cannot disagree. The existing observable-store, hot-reload and status-colour machinery is reused unchanged.

**Tech Stack:** TypeScript, React 18, TanStack Query + Router, Tailwind v4 (`@theme inline`), Tauri v2 + WKWebView, Node sidecar over kkrpc, `bun test` with happy-dom, Playwright for e2e, Biome.

**Spec:** `docs/superpowers/specs/2026-11-13-runtime-themes-design.md` — §6 in particular. §1 (hybrid class+token mechanism), §2 (theme file format) and §4 (failure handling) are unchanged and still bind.

## Global Constraints

- The effective appearance drives the `.dark` class. A theme's own `appearance` field governs **only** slot eligibility. Never toggle the class from `theme.appearance`.
- The class toggle must happen **after** all `--bb-*` properties are written. `status-colors-mount.tsx` and `project-status-colors.tsx` observe `attributeFilter: ["class", "style"]`, and `applyTheme`'s writes are synchronous so they coalesce into one observer callback.
- Colour values are `#rrggbb` or `rgb()`/`rgba()` only. `oklch()` and `color-mix()` stay rejected by validation.
- Theme ids match `THEME_ID_RE` from `@beadbox/server/theme-tokens` — the single source. Do not re-declare the pattern.
- A malformed theme is rejected atomically, reported in place with its reason, and never moved or renamed. The theme on screen stays.
- **Do NOT run `bun run check`.** It is `biome check --write packages/` and rewrites all 164 files. Lint only the files you touched: `bunx biome check --write <path>`.
- Typecheck per package and name it: `cd packages/client && bun run typecheck`. `bun test` transpiles **without** typechecking.
- Run the **full** suite for any package you touch before reporting done, not a scoped subset.
- Stage **explicit paths**: `git add <path> ...`. Never `git add -A`, `git add .`, or `git commit -a`. After committing, run `git show --stat` and confirm the file list.
- Baselines at the start of this plan: client 1031 pass / 0 fail; server 1084 pass / 5 skip / 0 fail; e2e 39 passed; both typechecks clean.

---

### Task 1: The three-value preference model

**Files:**
- Modify: `packages/client/src/lib/local-storage.ts`
- Test: `packages/client/src/__tests__/theme.test.ts`

The theme preference machinery already lives in `local-storage.ts` (a module-scoped `EventTarget`, an in-memory fallback, `subscribeThemePreference`). Extend it in place rather than extracting a new module: every other user preference lives here, the store and its tests already work, and a split would churn seven call sites for no behavioural gain.

**Interfaces:**
- Consumes: `THEME_ID_RE` and `type Appearance` from `@beadbox/server/theme-tokens`; the existing `themePreferenceEvents` / `THEME_PREFERENCE_CHANGE_EVENT` / `subscribeThemePreference` in this file.
- Produces:
  - `type ThemeMode = "dark" | "light" | "system"`
  - `interface ThemePrefs { mode: ThemeMode; darkThemeId: ThemeId; lightThemeId: ThemeId }`
  - `const DEFAULT_LIGHT_THEME_ID = "beadbox-light"`
  - `const DEFAULT_THEME_PREFS: ThemePrefs`
  - `getThemePrefs(): ThemePrefs`
  - `setThemeMode(mode: ThemeMode): void`
  - `setThemeForAppearance(appearance: Appearance, id: ThemeId): void`
  - `getLegacyThemeId(): ThemeId | null`
  - `clearLegacyThemeId(): void`

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/__tests__/theme.test.ts`. Keep the file's existing `afterEach` reset (`_resetThemePreferenceForTests()`) — the module-level in-memory value leaks across test files in one bun process otherwise.

```ts
describe("theme prefs (appearance mode)", () => {
  test("defaults to dark mode with both built-in slots filled", () => {
    expect(getThemePrefs()).toEqual({
      mode: "dark",
      darkThemeId: "beadbox-dark",
      lightThemeId: "beadbox-light",
    })
  })

  test("setThemeMode persists and notifies", () => {
    let calls = 0
    const un = subscribeThemePreference(() => {
      calls++
    })
    try {
      setThemeMode("system")
      expect(getThemePrefs().mode).toBe("system")
      expect(calls).toBe(1)
    } finally {
      un()
    }
  })

  test("setThemeForAppearance writes only the named slot", () => {
    setThemeForAppearance("light", "solarized")
    expect(getThemePrefs().lightThemeId).toBe("solarized")
    expect(getThemePrefs().darkThemeId).toBe("beadbox-dark")
  })

  test("rejects an invalid mode and an invalid id without writing", () => {
    setThemeMode("neon" as never)
    expect(getThemePrefs().mode).toBe("dark")
    setThemeForAppearance("dark", "../etc/passwd")
    expect(getThemePrefs().darkThemeId).toBe("beadbox-dark")
  })

  test("a corrupt stored blob falls back to defaults rather than throwing", () => {
    localStorage.setItem("beads-theme-prefs", "{not json")
    _resetThemePreferenceForTests()
    expect(getThemePrefs()).toEqual(DEFAULT_THEME_PREFS)
  })

  test("a partial stored blob fills missing keys from defaults", () => {
    localStorage.setItem("beads-theme-prefs", JSON.stringify({ mode: "light" }))
    _resetThemePreferenceForTests()
    expect(getThemePrefs()).toEqual({
      mode: "light",
      darkThemeId: "beadbox-dark",
      lightThemeId: "beadbox-light",
    })
  })

  test("writes still apply for the session when localStorage throws", () => {
    const original = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error("quota")
    }
    try {
      setThemeMode("light")
      expect(getThemePrefs().mode).toBe("light")
    } finally {
      localStorage.setItem = original
    }
  })

  test("exposes and clears the legacy single-id key", () => {
    localStorage.setItem("beads-theme", "nord")
    expect(getLegacyThemeId()).toBe("nord")
    clearLegacyThemeId()
    expect(getLegacyThemeId()).toBeNull()
  })

  test("ignores a malformed legacy id", () => {
    localStorage.setItem("beads-theme", "../nope")
    expect(getLegacyThemeId()).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/client && bun test src/__tests__/theme.test.ts`
Expected: FAIL — `getThemePrefs` is not exported.

- [ ] **Step 3: Implement the model**

In `packages/client/src/lib/local-storage.ts`. Add `import type { Appearance } from "@beadbox/server/theme-tokens"` to the existing `@beadbox/server/theme-tokens` import.

```ts
const THEME_PREFS_KEY = "beads-theme-prefs"

export const DEFAULT_LIGHT_THEME_ID = "beadbox-light"

export type ThemeMode = "dark" | "light" | "system"

export interface ThemePrefs {
  mode: ThemeMode
  darkThemeId: ThemeId
  lightThemeId: ThemeId
}

export const DEFAULT_THEME_PREFS: ThemePrefs = {
  mode: "dark",
  darkThemeId: DEFAULT_THEME_ID,
  lightThemeId: DEFAULT_LIGHT_THEME_ID,
}

const THEME_MODES: readonly ThemeMode[] = ["dark", "light", "system"]
const isThemeMode = (v: unknown): v is ThemeMode => THEME_MODES.includes(v as ThemeMode)

// One key holding all three values, so a change produces ONE store
// notification instead of three keys that can drift mid-update.
let currentThemePrefs: ThemePrefs | null = null

export function getThemePrefs(): ThemePrefs {
  if (typeof window === "undefined") return DEFAULT_THEME_PREFS
  if (currentThemePrefs !== null) return currentThemePrefs

  try {
    const raw = localStorage.getItem(THEME_PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ThemePrefs>
      // Each field is validated independently and falls back on its own, so a
      // single bad value cannot discard the user's other two choices.
      return {
        mode: isThemeMode(parsed.mode) ? parsed.mode : DEFAULT_THEME_PREFS.mode,
        darkThemeId:
          typeof parsed.darkThemeId === "string" && THEME_ID_RE.test(parsed.darkThemeId)
            ? parsed.darkThemeId
            : DEFAULT_THEME_PREFS.darkThemeId,
        lightThemeId:
          typeof parsed.lightThemeId === "string" && THEME_ID_RE.test(parsed.lightThemeId)
            ? parsed.lightThemeId
            : DEFAULT_THEME_PREFS.lightThemeId,
      }
    }
  } catch {
    // Unparseable blob or localStorage unavailable (private mode, disabled
    // storage). Defaults render today's appearance, so this degrades rather
    // than failing.
  }
  return DEFAULT_THEME_PREFS
}

function writeThemePrefs(next: ThemePrefs): void {
  currentThemePrefs = next
  try {
    localStorage.setItem(THEME_PREFS_KEY, JSON.stringify(next))
  } catch {
    // Non-fatal: currentThemePrefs above already holds the new value, so
    // getThemePrefs returns it and the choice applies for this session even
    // though it will not persist across reloads.
  }
  // Dispatched outside the try/catch for the same reason: subscribers must
  // still be notified when the write itself failed, or "applies for this
  // session" would not be true.
  themePreferenceEvents.dispatchEvent(new Event(THEME_PREFERENCE_CHANGE_EVENT))
}

export function setThemeMode(mode: ThemeMode): void {
  if (typeof window === "undefined") return
  if (!isThemeMode(mode)) return
  writeThemePrefs({ ...getThemePrefs(), mode })
}

export function setThemeForAppearance(appearance: Appearance, id: ThemeId): void {
  if (typeof window === "undefined") return
  if (!THEME_ID_RE.test(id)) return
  const prefs = getThemePrefs()
  writeThemePrefs(
    appearance === "dark" ? { ...prefs, darkThemeId: id } : { ...prefs, lightThemeId: id },
  )
}

/**
 * The pre-§6 single-id key, for one-time migration.
 *
 * Reading it here rather than migrating here is deliberate: choosing which
 * slot the id belongs in needs the theme's `appearance`, which only the
 * loaded theme list knows. hooks/use-theme.ts owns that step (Task 4).
 */
export function getLegacyThemeId(): ThemeId | null {
  if (typeof window === "undefined") return null
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored && THEME_ID_RE.test(stored)) return stored
  } catch {
    // localStorage unavailable.
  }
  return null
}

export function clearLegacyThemeId(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(THEME_KEY)
  } catch {
    // localStorage unavailable; nothing to clear.
  }
}
```

Extend the existing `_resetThemePreferenceForTests()` to also clear the new in-memory value:

```ts
export function _resetThemePreferenceForTests(): void {
  currentThemeId = null
  currentThemePrefs = null
}
```

Add `THEME_PREFS_KEY` to `CLEARABLE_KEYS`, and reset `currentThemePrefs` in `clearCache()` beside the existing `currentThemeId = null` so a cleared cache does not keep serving stale prefs from memory.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full client suite and typecheck**

Run: `cd packages/client && bun test && bun run typecheck`
Expected: 1031 + your new tests pass, 0 fail; typecheck clean. `getThemePreference`/`setThemePreference` are still exported and untouched, so nothing else breaks yet.

- [ ] **Step 6: Lint and commit**

```bash
bunx biome check --write packages/client/src/lib/local-storage.ts packages/client/src/__tests__/theme.test.ts
git add packages/client/src/lib/local-storage.ts packages/client/src/__tests__/theme.test.ts
git commit -m "feat(themes): three-value appearance-mode preference model"
git show --stat
```

---

### Task 2: Appearance resolution and the system listener

**Files:**
- Create: `packages/client/src/lib/appearance.ts`
- Test: `packages/client/src/__tests__/appearance.test.ts`

**Interfaces:**
- Consumes: `type ThemeMode` from `../lib/local-storage`; `type Appearance` from `@beadbox/server/theme-tokens`.
- Produces:
  - `resolveAppearance(mode: ThemeMode, prefersDark: boolean): Appearance`
  - `prefersDarkNow(): boolean`
  - `subscribeSystemAppearance(listener: () => void): () => void`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/client/src/__tests__/appearance.test.ts
import { describe, expect, test } from "bun:test"
import { prefersDarkNow, resolveAppearance, subscribeSystemAppearance } from "../lib/appearance"

describe("resolveAppearance", () => {
  test("an explicit mode ignores the system preference", () => {
    expect(resolveAppearance("dark", false)).toBe("dark")
    expect(resolveAppearance("dark", true)).toBe("dark")
    expect(resolveAppearance("light", true)).toBe("light")
    expect(resolveAppearance("light", false)).toBe("light")
  })

  test("system mode follows the system preference", () => {
    expect(resolveAppearance("system", true)).toBe("dark")
    expect(resolveAppearance("system", false)).toBe("light")
  })
})

describe("system appearance listener", () => {
  test("prefersDarkNow reads the media query", () => {
    const original = window.matchMedia
    // @ts-expect-error test seam
    window.matchMedia = (q: string) => ({
      matches: q.includes("dark"),
      addEventListener() {},
      removeEventListener() {},
    })
    try {
      expect(prefersDarkNow()).toBe(true)
    } finally {
      window.matchMedia = original
    }
  })

  test("subscribe attaches a change listener and its unsubscribe detaches it", () => {
    const original = window.matchMedia
    let added = 0
    let removed = 0
    // @ts-expect-error test seam
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {
        added++
      },
      removeEventListener() {
        removed++
      },
    })
    try {
      const un = subscribeSystemAppearance(() => {})
      expect(added).toBe(1)
      un()
      expect(removed).toBe(1)
    } finally {
      window.matchMedia = original
    }
  })

  test("degrades to a no-op where matchMedia is unavailable", () => {
    const original = window.matchMedia
    // @ts-expect-error test seam
    window.matchMedia = undefined
    try {
      expect(prefersDarkNow()).toBe(false)
      expect(() => subscribeSystemAppearance(() => {})()).not.toThrow()
    } finally {
      window.matchMedia = original
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/appearance.test.ts`
Expected: FAIL — cannot resolve `../lib/appearance`.

- [ ] **Step 3: Implement**

```ts
// packages/client/src/lib/appearance.ts
// Resolves the user's appearance MODE into the appearance actually rendered,
// and exposes the OS preference as a subscribable value.
//
// The resolved appearance — not a theme's own `appearance` field — is what
// drives the `.dark` class (spec §6). A theme's field governs only which slot
// it is eligible for, so the two cannot disagree.
//
// matchMedia usage mirrors hooks/use-viewport.ts, which already listens to
// media queries this way rather than polling.

import type { Appearance } from "@beadbox/server/theme-tokens"
import type { ThemeMode } from "./local-storage"

const DARK_QUERY = "(prefers-color-scheme: dark)"

export function resolveAppearance(mode: ThemeMode, prefersDark: boolean): Appearance {
  if (mode === "system") return prefersDark ? "dark" : "light"
  return mode
}

export function prefersDarkNow(): boolean {
  // Guarded rather than assumed: happy-dom and older webviews may not
  // implement matchMedia, and a missing OS signal should read as "not dark"
  // instead of throwing during startup.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  try {
    return window.matchMedia(DARK_QUERY).matches
  } catch {
    return false
  }
}

export function subscribeSystemAppearance(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {}
  }
  try {
    const mql = window.matchMedia(DARK_QUERY)
    mql.addEventListener("change", listener)
    return () => mql.removeEventListener("change", listener)
  } catch {
    return () => {}
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/client && bun test src/__tests__/appearance.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
bunx biome check --write packages/client/src/lib/appearance.ts packages/client/src/__tests__/appearance.test.ts
git add packages/client/src/lib/appearance.ts packages/client/src/__tests__/appearance.test.ts
git commit -m "feat(themes): resolve appearance mode, with a live system listener"
git show --stat
```

---

### Task 3: `applyTheme` takes the appearance explicitly

**Files:**
- Modify: `packages/client/src/lib/theme-engine.ts`
- Modify: `packages/client/src/hooks/use-theme.ts` (call site only — the full rewire is Task 4)
- Test: `packages/client/src/__tests__/theme-engine.test.ts`

**Interfaces:**
- Consumes: `applyThemeClass(el, appearance)` from `../lib/theme`.
- Produces: `applyTheme(theme: Theme, appearance: Appearance, el?: HTMLElement): void` — a **breaking signature change**; `appearance` is now required and `theme.appearance` is no longer read by this function.

- [ ] **Step 1: Write the failing test**

Add to `packages/client/src/__tests__/theme-engine.test.ts`:

```ts
test("the class follows the appearance argument, not the theme's own field", () => {
  const el = document.createElement("div")
  const darkTheme = { ...darkJson, appearance: "dark" } as Theme

  applyTheme(darkTheme, "light", el)
  expect(el.classList.contains("dark")).toBe(false)

  applyTheme(darkTheme, "dark", el)
  expect(el.classList.contains("dark")).toBe(true)
})

test("tokens are still written before the class toggles", () => {
  const el = document.createElement("div")
  const order: string[] = []
  const realSet = el.style.setProperty.bind(el.style)
  el.style.setProperty = (k: string, v: string) => {
    order.push(`set:${k}`)
    realSet(k, v)
  }
  const realToggle = el.classList.toggle.bind(el.classList)
  el.classList.toggle = (c: string, f?: boolean) => {
    order.push("toggle")
    return realToggle(c, f)
  }

  applyTheme(darkJson as Theme, "dark", el)

  expect(order.at(-1)).toBe("toggle")
  expect(order.filter((o) => o === "toggle")).toHaveLength(1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/client && bun test src/__tests__/theme-engine.test.ts`
Expected: FAIL — `applyTheme` takes 2 arguments, so the appearance lands in the `el` position.

- [ ] **Step 3: Change the signature**

In `packages/client/src/lib/theme-engine.ts`, replace `applyTheme`'s signature and its final toggle:

```ts
export function applyTheme(
  theme: Theme,
  appearance: Appearance,
  el: HTMLElement = document.documentElement,
): void {
```

and

```ts
  // Toggle appearance last so observers see a fully-applied theme.
  // Delegates to theme.ts's applyThemeClass so exactly one function in the
  // codebase maps an Appearance to the dark class.
  //
  // The appearance comes from the caller (the resolved MODE, spec §6), not
  // from theme.appearance: a theme's own field governs only which slot it is
  // eligible for. Reading it here instead would let a mis-slotted theme paint
  // dark tokens under a light class.
  applyThemeClass(el, appearance)
```

Add `type Appearance` to the existing `@beadbox/server/theme-tokens` import.

Update the one existing call site in `packages/client/src/hooks/use-theme.ts` to `applyTheme(theme, theme.appearance)` as a temporary bridge — Task 4 replaces it with the resolved appearance. Leave a `// TODO(task 4)` marker on that line so the bridge is not mistaken for the final state.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/client && bun test src/__tests__/theme-engine.test.ts && bun test`
Expected: both PASS. Existing `applyTheme` callers in tests will need their second argument updated — update them to pass the theme's own appearance so their behaviour is unchanged.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd packages/client && bun run typecheck
cd ../.. && bunx biome check --write packages/client/src/lib/theme-engine.ts packages/client/src/hooks/use-theme.ts packages/client/src/__tests__/theme-engine.test.ts
git add packages/client/src/lib/theme-engine.ts packages/client/src/hooks/use-theme.ts packages/client/src/__tests__/theme-engine.test.ts
git commit -m "refactor(themes): applyTheme takes the resolved appearance"
git show --stat
```

---

### Task 4: Rewire the hooks, and migrate the legacy preference

**Files:**
- Modify: `packages/client/src/hooks/use-theme-preference.ts`
- Modify: `packages/client/src/hooks/use-theme.ts`
- Modify: `packages/client/src/hooks/use-preferences.ts`
- Test: `packages/client/src/__tests__/use-theme.test.tsx`

**Interfaces:**
- Consumes: Task 1's `getThemePrefs`, `setThemeMode`, `setThemeForAppearance`, `getLegacyThemeId`, `clearLegacyThemeId`, `subscribeThemePreference`; Task 2's `resolveAppearance`, `prefersDarkNow`, `subscribeSystemAppearance`; Task 3's `applyTheme(theme, appearance, el?)`.
- Produces:
  - `useThemePreference(): { mode: ThemeMode; darkThemeId: ThemeId; lightThemeId: ThemeId; appearance: Appearance; activeThemeId: ThemeId; setMode: (m: ThemeMode) => void; setThemeForAppearance: (a: Appearance, id: ThemeId) => void }`
  - `useTheme(): { activeThemeId: ThemeId; appearance: Appearance; available: boolean }`

- [ ] **Step 1: Write the failing tests**

Add to `packages/client/src/__tests__/use-theme.test.tsx`, following the file's existing harness (its `installThemeChangeListener()` helper, the singleton `queryClient` wrapper, and the `_resetThemePreferenceForTests()` / `__resetProbeCache()` resets in `afterEach`).

```tsx
test("applies the dark slot's theme in dark mode", async () => {
  setThemeMode("dark")
  setThemeForAppearance("dark", "beadbox-dark")
  renderProbe()
  await waitFor(() => {
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })
})

test("switching mode to light applies the light slot's theme and drops the class", async () => {
  renderProbe()
  await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))

  act(() => {
    setThemeMode("light")
  })

  await waitFor(() => {
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--bb-background").trim()).toBe(
      lightJson.colors.background,
    )
  })
})

test("system mode follows the OS, and a live OS change re-resolves it", async () => {
  // Drive the media query through a settable seam so the change event can fire.
  let prefersDark = true
  const listeners = new Set<() => void>()
  const original = window.matchMedia
  // @ts-expect-error test seam
  window.matchMedia = () => ({
    get matches() {
      return prefersDark
    },
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  })
  try {
    setThemeMode("system")
    renderProbe()
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))

    act(() => {
      prefersDark = false
      for (const l of listeners) l()
    })

    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false))
  } finally {
    window.matchMedia = original
  }
})

test("migrates a legacy single-id preference into the slot matching its appearance", async () => {
  localStorage.setItem("beads-theme", "beadbox-light")
  _resetThemePreferenceForTests()

  renderProbe()

  await waitFor(() => {
    expect(getThemePrefs()).toEqual({
      mode: "light",
      darkThemeId: "beadbox-dark",
      lightThemeId: "beadbox-light",
    })
  })
  // The legacy key is removed so it cannot become a second source of truth.
  expect(localStorage.getItem("beads-theme")).toBeNull()
})

test("a legacy id whose theme is no longer installed falls back to defaults", async () => {
  localStorage.setItem("beads-theme", "uninstalled")
  _resetThemePreferenceForTests()

  renderProbe()

  await waitFor(() => {
    expect(getThemePrefs()).toEqual(DEFAULT_THEME_PREFS)
  })
  expect(localStorage.getItem("beads-theme")).toBeNull()
})

test("migration does not run when prefs already exist", async () => {
  setThemeMode("light")
  localStorage.setItem("beads-theme", "beadbox-dark")

  renderProbe()

  await waitFor(() => expect(getThemePrefs().mode).toBe("light"))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/client && bun test src/__tests__/use-theme.test.tsx`
Expected: FAIL — `setThemeMode` is not imported/used by the hooks yet, and no migration runs.

- [ ] **Step 3: Rewrite `use-theme-preference.ts`**

```ts
// Owns ONLY the subscription to the theme-preference store in
// local-storage.ts, plus the derivation of the appearance actually rendered.
// It does not apply the theme to <html>; that is use-theme.ts's job.
//
// A component that needs to read or change the preference (e.g. the settings
// dialog) must use this hook rather than useTheme, so it does not also mount
// a second applier alongside the root's.

import type { Appearance } from "@beadbox/server/theme-tokens"
import { useCallback, useSyncExternalStore } from "react"

import { prefersDarkNow, resolveAppearance, subscribeSystemAppearance } from "../lib/appearance"
import {
  getThemePrefs,
  setThemeForAppearance as persistThemeForAppearance,
  setThemeMode as persistThemeMode,
  subscribeThemePreference,
  type ThemeId,
  type ThemeMode,
} from "../lib/local-storage"

export function useThemePreference(): {
  mode: ThemeMode
  darkThemeId: ThemeId
  lightThemeId: ThemeId
  appearance: Appearance
  activeThemeId: ThemeId
  setMode: (mode: ThemeMode) => void
  setThemeForAppearance: (appearance: Appearance, id: ThemeId) => void
} {
  const prefs = useSyncExternalStore(subscribeThemePreference, getThemePrefs, getThemePrefs)
  // The OS preference is a second store: in system mode the rendered
  // appearance changes without any preference write, so it needs its own
  // subscription or the app would only follow the OS at startup.
  const prefersDark = useSyncExternalStore(
    subscribeSystemAppearance,
    prefersDarkNow,
    prefersDarkNow,
  )

  const appearance = resolveAppearance(prefs.mode, prefersDark)
  const activeThemeId = appearance === "dark" ? prefs.darkThemeId : prefs.lightThemeId

  const setMode = useCallback((mode: ThemeMode) => {
    persistThemeMode(mode)
  }, [])

  const setThemeForAppearance = useCallback((a: Appearance, id: ThemeId) => {
    persistThemeForAppearance(a, id)
  }, [])

  return {
    mode: prefs.mode,
    darkThemeId: prefs.darkThemeId,
    lightThemeId: prefs.lightThemeId,
    appearance,
    activeThemeId,
    setMode,
    setThemeForAppearance,
  }
}
```

Note `getThemePrefs` returns a fresh object each call when nothing is cached, which `useSyncExternalStore` would see as a changed snapshot every render. Task 1's `currentThemePrefs` memo covers the post-write case; for the pre-write case, cache the parsed value in `currentThemePrefs` on first read inside `getThemePrefs` so the identity is stable. Make that change in `local-storage.ts` as part of this task and add a test asserting two successive `getThemePrefs()` calls return the identical object.

- [ ] **Step 4: Rewire `use-theme.ts`**

Keep every existing mechanism — the probe, `reapplyEpoch`, `transportEpoch`, the stderr listener, the hot-reload guard, the test seams. Three changes:

1. Replace `const { themeId, setTheme } = useThemePreference()` with `const { activeThemeId, appearance } = useThemePreference()`, and use `activeThemeId` everywhere `themeId` was used (including `themeIdRef` and the hot-reload `stillValid` lookup).
2. Pass the resolved appearance to the engine: `applyTheme(theme, appearance)`. Add `appearance` to the apply effect's dependency array so a mode change re-applies.
3. Add the one-time legacy migration, before the apply effect:

```ts
// One-time migration from the pre-§6 single-id preference. It lives here
// rather than in local-storage.ts because choosing the slot needs the
// theme's `appearance`, which only the loaded list knows.
const migratedRef = useRef(false)
useEffect(() => {
  if (migratedRef.current) return
  const legacyId = getLegacyThemeId()
  if (!legacyId) {
    migratedRef.current = true
    return
  }
  migratedRef.current = true
  let cancelled = false
  void queryClient
    .fetchQuery({ queryKey: themesQueryKey, queryFn: listThemes })
    .then((entries) => {
      if (cancelled) return
      const entry = entries.find((e) => e.id === legacyId && !e.error)
      // An id whose theme is no longer installed (or no longer validates)
      // cannot be slotted, so the defaults stand rather than guessing an
      // appearance for it.
      if (entry) {
        setThemeForAppearance(entry.appearance, legacyId)
        setThemeMode(entry.appearance)
      }
      clearLegacyThemeId()
    })
    .catch(() => {
      // List unavailable (no sidecar). Leave the legacy key in place so the
      // migration can retry on a later launch rather than silently discarding
      // the user's choice.
    })
  return () => {
    cancelled = true
  }
}, [queryClient])
```

Return `{ activeThemeId, appearance, available }`.

- [ ] **Step 5: Update `use-preferences.ts`**

It currently does `const { themeId: theme, setTheme: handleThemeChange } = useThemePreference()` and re-exports `theme` / `handleThemeChange` (lines 34, 181-182). Those two exports exist only to prop-drill into `SettingsDialog`, which Task 5 changes to read the store directly. Remove both the destructure and the two exported fields.

Verify nothing else consumes them before removing:

```bash
grep -rn 'prefs\.theme\b\|prefs\.handleThemeChange\|\.handleThemeChange' packages/client/src | grep -v __tests__
```

If anything other than `SettingsDialog` call sites appears, stop and report it rather than removing.

- [ ] **Step 6: Run the full client suite and typecheck**

Run: `cd packages/client && bun test && bun run typecheck`
Expected: PASS. The seven `SettingsDialog` call sites still pass `theme`/`onThemeChange` props at this point, so typecheck will flag them only once Task 5 removes those props — if it flags them now, you removed too much from `use-preferences.ts`.

- [ ] **Step 7: Lint and commit**

```bash
bunx biome check --write packages/client/src/hooks/use-theme-preference.ts packages/client/src/hooks/use-theme.ts packages/client/src/hooks/use-preferences.ts packages/client/src/lib/local-storage.ts packages/client/src/__tests__/use-theme.test.tsx
git add packages/client/src/hooks/use-theme-preference.ts packages/client/src/hooks/use-theme.ts packages/client/src/hooks/use-preferences.ts packages/client/src/lib/local-storage.ts packages/client/src/__tests__/use-theme.test.tsx
git commit -m "feat(themes): apply the slot theme for the resolved appearance"
git show --stat
```

---

### Task 5: The settings UI — mode selector and two slot grids

**Files:**
- Modify: `packages/client/src/components/settings-dialog.tsx`
- Modify: the seven `SettingsDialog` call sites (find with `grep -rn '<SettingsDialog' packages/client/src | grep -v __tests__`)
- Test: `packages/client/src/__tests__/settings-theme-picker.test.tsx`

**Interfaces:**
- Consumes: Task 4's `useThemePreference()`; the existing `listThemes`/`themesQueryKey`, `isThemingAvailable`, `resolveThemeId`, and the existing card grid, `handleThemeKeyDown`, `nextSelectableThemeIndex`, previews and error cards.
- Produces: no new exports. `SettingsDialogProps` **loses** `theme` and `onThemeChange`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/client/src/__tests__/settings-theme-picker.test.tsx`, following its existing `stubThemesRpc` / `renderDialog` helpers (drop the theme-id argument from `renderDialog` as part of this task, since the dialog no longer takes the prop).

```tsx
test("renders a mode selector with dark, light and system", async () => {
  stubThemesRpc([])
  renderDialog()
  await waitFor(() => {
    expect(screen.getByRole("radio", { name: /dark mode/i })).toBeDefined()
    expect(screen.getByRole("radio", { name: /light mode/i })).toBeDefined()
    expect(screen.getByRole("radio", { name: /system/i })).toBeDefined()
  })
})

test("choosing a mode persists it", async () => {
  stubThemesRpc([])
  renderDialog()
  await waitFor(() => screen.getByRole("radio", { name: /light mode/i }))
  fireEvent.click(screen.getByRole("radio", { name: /light mode/i }))
  await waitFor(() => expect(getThemePrefs().mode).toBe("light"))
})

test("each slot grid offers only themes of its own appearance", async () => {
  stubThemesRpc([
    { id: "nord", name: "Nord", appearance: "dark", source: "user" },
    { id: "solar", name: "Solar", appearance: "light", source: "user" },
  ])
  renderDialog()

  await waitFor(() => screen.getByRole("radiogroup", { name: /dark theme/i }))
  const darkGrid = screen.getByRole("radiogroup", { name: /dark theme/i })
  const lightGrid = screen.getByRole("radiogroup", { name: /light theme/i })

  expect(within(darkGrid).getByText("Nord")).toBeDefined()
  expect(within(darkGrid).queryByText("Solar")).toBeNull()
  expect(within(lightGrid).getByText("Solar")).toBeDefined()
  expect(within(lightGrid).queryByText("Nord")).toBeNull()
})

test("both grids stay visible in either mode, so the inactive slot is configurable", async () => {
  stubThemesRpc([])
  renderDialog()
  await waitFor(() => screen.getByRole("radiogroup", { name: /dark theme/i }))
  fireEvent.click(screen.getByRole("radio", { name: /light mode/i }))
  await waitFor(() => {
    expect(screen.getByRole("radiogroup", { name: /dark theme/i })).toBeDefined()
    expect(screen.getByRole("radiogroup", { name: /light theme/i })).toBeDefined()
  })
})

test("selecting in a slot writes only that slot", async () => {
  stubThemesRpc([{ id: "nord", name: "Nord", appearance: "dark", source: "user" }])
  renderDialog()
  await waitFor(() => screen.getByText("Nord"))
  fireEvent.click(screen.getByRole("radio", { name: /Nord theme/i }))
  await waitFor(() => {
    expect(getThemePrefs().darkThemeId).toBe("nord")
    expect(getThemePrefs().lightThemeId).toBe("beadbox-light")
  })
})

test("an invalid theme still shows its reason and stays unselectable, per grid", async () => {
  stubThemesRpc([
    { id: "bad", name: "Bad", appearance: "dark", source: "user", error: "colors.ring is missing" },
  ])
  renderDialog()
  await waitFor(() => expect(screen.getByText(/colors\.ring is missing/)).toBeDefined())
  const card = screen.getByRole("radio", { name: /Bad theme/i }) as HTMLButtonElement
  expect(card.disabled).toBe(true)
  fireEvent.click(card)
  await waitFor(() => expect(getThemePrefs().darkThemeId).toBe("beadbox-dark"))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/client && bun test src/__tests__/settings-theme-picker.test.tsx`
Expected: FAIL — no mode selector, one unnamed radiogroup.

- [ ] **Step 3: Extract the grid into a local component**

The existing grid body is rendered twice now. Extract it into one local component inside `settings-dialog.tsx` — do not copy-paste it into two places, and do not create a new file.

What moves into the component: the `role="radiogroup"` element and its card markup (the block beginning at the `aria-label="Theme selection"` radiogroup, currently inside the `!themingAvailable ? ... : (` ternary in the Theme section), plus the `focusedThemeIndex` state, the `themeCardRefs` ref, the focus-sync effect, and `handleThemeKeyDown`. `nextSelectableThemeIndex` is already a module-level helper taking `(themes, from, dir)` — leave it at module level and call it from the component.

`ThemeEntry` is already imported in this file (line 48). `Appearance` is not — add `import type { Appearance } from "@beadbox/server/theme-tokens"`.

```tsx
function ThemeSlotGrid({
  label,
  slot,
  themes,
  selectedId,
  onSelect,
}: {
  label: string
  slot: Appearance
  themes: readonly ThemeEntry[]
  selectedId: ThemeId
  onSelect: (id: ThemeId) => void
}) {
  // Each grid owns its own roving tabIndex, so arrow keys stay within one
  // slot and the two grids are independent Tab stops.
  const [focusedIndex, setFocusedIndex] = useState(0)
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([])
  // ...the existing focus-sync effect, handleThemeKeyDown and card markup,
  // moved verbatim and parameterised on `themes` / `selectedId` / `onSelect`.
}
```

Keep every behaviour the single grid already had: the preview swatches, `aria-checked`, `aria-label={`${t.name} theme`}`, the `safeCapture("app_setting_changed", …)` analytics on both the click and keyboard paths, the `disabled` + `aria-disabled` error card showing `t.error`, and `nextSelectableThemeIndex`'s skip-invalid behaviour including its fallback when the resolved selection lands on an errored card.

Give each grid an accessible name so the tests can address them: `aria-label={`${label} theme`}` on the radiogroup, i.e. "Dark theme" and "Light theme".

- [ ] **Step 4: Render the mode selector and both grids**

Replace the single grid in the Theme section with:

```tsx
const { mode, darkThemeId, lightThemeId, setMode, setThemeForAppearance } = useThemePreference()
const darkThemes = themes.filter((t) => t.appearance === "dark")
const lightThemes = themes.filter((t) => t.appearance === "light")
```

```tsx
<h3 className="text-lg font-semibold mb-1">Theme</h3>
<p className="text-sm text-muted-foreground mb-4">
  Choose when to use a light or dark appearance, and which theme to use for each.
</p>

<div role="radiogroup" aria-label="Appearance mode" className="flex gap-2 mb-6">
  {(["dark", "light", "system"] as const).map((m) => (
    <button
      key={m}
      type="button"
      role="radio"
      aria-checked={mode === m}
      aria-label={m === "system" ? "Follow system appearance" : `${m} mode`}
      onClick={() => {
        if (getAnalyticsEnabled()) {
          safeCapture("app_setting_changed", {
            setting: "theme_mode",
            old_value: mode,
            new_value: m,
          })
        }
        setMode(m)
      }}
      className={cn(
        "rounded-md border px-3 py-1.5 text-sm capitalize transition-colors",
        mode === m ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
      )}
    >
      {m === "system" ? "System" : m}
    </button>
  ))}
</div>

<ThemeSlotGrid
  label="Dark"
  slot="dark"
  themes={darkThemes}
  selectedId={darkThemeId}
  onSelect={(id) => setThemeForAppearance("dark", id)}
/>
<ThemeSlotGrid
  label="Light"
  slot="light"
  themes={lightThemes}
  selectedId={lightThemeId}
  onSelect={(id) => setThemeForAppearance("light", id)}
/>
```

Keep the existing `themingAvailable === false` branch exactly as it is — one explanatory message matching `/not supported/i` with no `role="radio"` elements rendered — and show it in place of the mode selector and both grids.

- [ ] **Step 5: Remove the now-unused props**

Delete `theme: ThemeId` and `onThemeChange: (theme: ThemeId) => void` from `SettingsDialogProps` and from the component's destructured parameters. Then remove the `theme={...}` and `onThemeChange={...}` attributes from all seven call sites — these exact files:

- `packages/client/src/components/activity-page.tsx`
- `packages/client/src/components/chart-view.tsx`
- `packages/client/src/components/formulas-view.tsx`
- `packages/client/src/components/global-settings-button.tsx`
- `packages/client/src/components/home-page.tsx`
- `packages/client/src/components/trains-page.tsx`
- `packages/client/src/components/waiting-page.tsx`

Each is a two-line deletion inside the `<SettingsDialog ... />` element. Do not change anything else in those files. Several of them also call `usePreferences()` for unrelated settings (zoom, vim navigation, update checks) — leave all of that alone.

- [ ] **Step 6: Run the full client suite and typecheck**

Run: `cd packages/client && bun test && bun run typecheck`
Expected: PASS. Typecheck is the gate that proves all seven call sites were updated.

- [ ] **Step 7: Lint and commit**

```bash
bunx biome check --write packages/client/src/components/settings-dialog.tsx \
  packages/client/src/__tests__/settings-theme-picker.test.tsx \
  packages/client/src/components/activity-page.tsx \
  packages/client/src/components/chart-view.tsx \
  packages/client/src/components/formulas-view.tsx \
  packages/client/src/components/global-settings-button.tsx \
  packages/client/src/components/home-page.tsx \
  packages/client/src/components/trains-page.tsx \
  packages/client/src/components/waiting-page.tsx
git add packages/client/src/components/settings-dialog.tsx \
  packages/client/src/__tests__/settings-theme-picker.test.tsx \
  packages/client/src/components/activity-page.tsx \
  packages/client/src/components/chart-view.tsx \
  packages/client/src/components/formulas-view.tsx \
  packages/client/src/components/global-settings-button.tsx \
  packages/client/src/components/home-page.tsx \
  packages/client/src/components/trains-page.tsx \
  packages/client/src/components/waiting-page.tsx
git commit -m "feat(themes): mode selector and per-appearance theme slots"
git show --stat
```

---

### Task 6: End-to-end coverage

**Files:**
- Modify: `e2e/headless/theme-switch.spec.ts`
- Test: itself

**Context:** read `e2e/headless/theme-switch.spec.ts` and `e2e/headless/status-colors.spec.ts` first. Import `test`/`expect` from `../fixtures/harness`, **never** from `@playwright/test` directly: without the harness fixture the test bridge is not installed, the app renders a "test transport not installed" error screen, and theme assertions still pass against it because tokens are applied by a root effect independent of the rest of the render. That false positive already happened once on this feature.

Note `e2e/**` sits outside `biome.json`'s `files.includes`, so linting it is a no-op — match the surrounding style by hand.

**Interfaces:** consumes the shipped app; produces nothing.

- [ ] **Step 1: Update the existing live-switch test**

The current test clicks a theme card directly. The picker now has a mode selector, so selecting "light mode" is the action that flips appearance. Rewrite that test to open settings, click the light-mode radio, and assert — with **no reload** — that `html` loses `dark` and `--bb-background` becomes the light theme's value, then that it survives a reload.

Read the expected colour from `packages/client/src/themes/beadbox-light.json` rather than hardcoding it.

- [ ] **Step 2: Add a slot-assignment test**

Assert that assigning a theme in the dark slot while in light mode does **not** change the current appearance, and that switching to dark mode then applies it. This is the property the two-axis model exists for and the one a single-axis regression would break.

- [ ] **Step 3: Add a system-mode test**

Playwright can emulate the OS preference with `page.emulateMedia({ colorScheme: "dark" | "light" })`. Set mode to system, emulate dark, assert the dark class; emulate light, assert it drops — **without** a reload, which is what proves the `change` listener works rather than just the startup read.

If `emulateMedia` turns out not to work through this harness, report the specific failure rather than deleting the test or weakening it to a reload-based check.

- [ ] **Step 4: Run the e2e suite**

Run: `bun run test:e2e`
Expected: all specs pass, including the pre-existing ones. `status-colors.spec.ts` especially — it covers appearance-vs-status-colour interaction, which this plan changes the trigger for.

If a pre-existing spec fails, that is a finding about the feature: report it with the output. Do not adjust the old spec to accommodate the new behaviour.

- [ ] **Step 5: Commit**

```bash
git add e2e/headless/theme-switch.spec.ts
git commit -m "test(themes): end-to-end appearance mode and slot assignment"
git show --stat
```
