// Merges the bundled built-in themes with whatever the sidecar finds on disk.
//
// Built-ins win on id collision so a user file named beadbox-dark.json cannot
// replace the theme the app falls back to. In browser/stub mode rpc throws
// RpcUnavailableError; that degrades to built-ins only (listThemes) or the
// per-appearance built-in (loadTheme, builtinThemeFor) rather than failing.

import type { Appearance, Theme } from "@beadbox/server/theme-tokens"
import { validateTheme } from "@beadbox/server/theme-validate"
import darkJson from "../themes/beadbox-dark.json"
import lightJson from "../themes/beadbox-light.json"
import { defaultThemeIdFor } from "./local-storage"
import { rpc } from "./rpc"

/**
 * Widens the sidecar's ThemeEntry (packages/server/src/lib/theme-files.ts),
 * whose `source` is always "user", to also describe bundled themes.
 * Structurally compatible, so a server entry assigns to this without
 * conversion. Keep the two in sync: adding a field here that the server does
 * not send will be `undefined` at runtime.
 *
 * `appearance` is nullable (final whole-plan review, Fix 2): a user theme
 * file that is not even valid JSON carries no recoverable appearance, so
 * the server reports `null` rather than guessing "dark". A null appearance
 * always comes with `error` set — such an entry can never be selected, only
 * shown with its error, outside both the dark and light grids.
 */
export interface ThemeEntry {
  id: string
  name: string
  appearance: Appearance | null
  source: "builtin" | "user"
  error?: string
  /**
   * Six colours for the picker's mini-UI preview, not the full token set.
   * Absent when the theme failed validation: there is nothing to preview.
   */
  preview?: Pick<
    Theme["colors"],
    "background" | "card" | "primary" | "secondary" | "mutedForeground" | "foreground"
  >
}

export const BUILTIN_THEMES: readonly Theme[] = [darkJson as Theme, lightJson as Theme]

/**
 * The built-in theme for a given appearance slot — the shared fallback
 * (final whole-plan review, Fix 1) used both by loadTheme's failure path and
 * by use-theme.ts's apply-effect appearance-mismatch guard. Always
 * resolves: BUILTIN_THEMES ships exactly one dark and one light entry, and
 * defaultThemeIdFor only ever names one of their ids.
 */
export function builtinThemeFor(appearance: Appearance): Theme {
  const id = defaultThemeIdFor(appearance)
  // Non-null by the invariant above — defaultThemeIdFor only ever returns
  // DEFAULT_THEME_ID or DEFAULT_LIGHT_THEME_ID, and BUILTIN_THEMES always
  // ships both.
  return BUILTIN_THEMES.find((t) => t.id === id) as Theme
}

/** Keys listThemes' react-query consumers share, so Task 13 can invalidate it. */
export const themesQueryKey = ["themes"] as const

function entryOf(t: Theme): ThemeEntry {
  const { background, card, primary, secondary, mutedForeground, foreground } = t.colors
  return {
    id: t.id,
    name: t.name,
    appearance: t.appearance,
    source: "builtin",
    preview: { background, card, primary, secondary, mutedForeground, foreground },
  }
}

/**
 * The built-ins alone, synchronously available (no rpc round trip). The
 * picker falls back to this while its `listThemes` query is still in
 * flight, so it renders Beadbox Dark/Light immediately instead of empty.
 */
export const BUILTIN_ENTRIES: readonly ThemeEntry[] = BUILTIN_THEMES.map(entryOf)

async function listThemesResult(): Promise<{ entries: ThemeEntry[]; degraded: boolean }> {
  const builtinIds = new Set(BUILTIN_ENTRIES.map((e) => e.id))
  let raw: ThemeEntry[] = []
  let degraded = false
  try {
    raw = await rpc.themes.list()
  } catch {
    // Sidecar unavailable (browser mode, or not yet connected) — degraded,
    // not "genuinely no user themes". listThemesWithStatus surfaces this
    // distinction for callers (use-theme.ts's legacy migration) that must
    // not treat a failed read the same as a successful empty one.
    degraded = true
  }
  const user = raw.filter((e) => !builtinIds.has(e.id))
  return { entries: [...BUILTIN_ENTRIES, ...user], degraded }
}

export async function listThemes(): Promise<ThemeEntry[]> {
  return (await listThemesResult()).entries
}

/**
 * Same merge as listThemes, but also reports whether the sidecar read
 * degraded to built-ins-only rather than genuinely returning an
 * empty/absent list. (final whole-plan review, Fix 3): the legacy
 * single-id migration needs this — a degraded read is not proof the
 * legacy theme id is uninstalled, and treating it as such would clear the
 * legacy key with no way to retry, discarding the user's preference.
 */
export async function listThemesWithStatus(): Promise<{
  entries: ThemeEntry[]
  degraded: boolean
}> {
  return listThemesResult()
}

export async function loadTheme(id: string, appearance: Appearance): Promise<Theme> {
  const builtin = BUILTIN_THEMES.find((t) => t.id === id)
  if (builtin) return builtin
  let raw: Theme | null = null
  try {
    raw = await rpc.themes.get(id)
  } catch {
    // Sidecar unavailable — fall through to this appearance's built-in.
  }
  if (raw) {
    // The sidecar already validated this theme on read, but it crossed a
    // process boundary to get here and applyTheme writes it straight into
    // the DOM, so it is re-validated before being trusted.
    const result = validateTheme(raw, { id })
    if (result.ok) return result.theme
  }
  // Appearance-specific, not always the dark built-in (final whole-plan
  // review, Fix 1): a light slot naming a missing or invalid theme must not
  // collapse to dark tokens while the resolved appearance keeps the .dark
  // class off — see use-theme.ts's apply effect for the other half of this.
  return builtinThemeFor(appearance)
}
