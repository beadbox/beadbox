// Merges the bundled built-in themes with whatever the sidecar finds on disk.
//
// Built-ins win on id collision so a user file named beadbox-dark.json cannot
// replace the theme the app falls back to. In browser/stub mode rpc throws
// RpcUnavailableError; that degrades to built-ins only (listThemes) or the
// fallback theme (loadTheme) rather than failing.

import type { Theme } from "@beadbox/server/theme-tokens"
import { validateTheme } from "@beadbox/server/theme-validate"
import darkJson from "../themes/beadbox-dark.json"
import lightJson from "../themes/beadbox-light.json"
import { rpc } from "./rpc"

/**
 * Widens the sidecar's ThemeEntry (packages/server/src/lib/theme-files.ts),
 * whose `source` is always "user", to also describe bundled themes.
 * Structurally compatible, so a server entry assigns to this without
 * conversion. Keep the two in sync: adding a field here that the server does
 * not send will be `undefined` at runtime.
 */
export interface ThemeEntry {
  id: string
  name: string
  appearance: "dark" | "light"
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

export const FALLBACK_THEME: Theme = darkJson as Theme

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

export async function listThemes(): Promise<ThemeEntry[]> {
  const builtinIds = new Set(BUILTIN_ENTRIES.map((e) => e.id))
  let raw: ThemeEntry[] = []
  try {
    raw = await rpc.themes.list()
  } catch {
    // Sidecar unavailable (browser mode, or not yet connected).
    raw = []
  }
  const user = raw.filter((e) => !builtinIds.has(e.id))
  return [...BUILTIN_ENTRIES, ...user]
}

export async function loadTheme(id: string): Promise<Theme> {
  const builtin = BUILTIN_THEMES.find((t) => t.id === id)
  if (builtin) return builtin
  let raw: Theme | null = null
  try {
    raw = await rpc.themes.get(id)
  } catch {
    // Sidecar unavailable — fall through to the fallback theme.
  }
  if (raw) {
    // The sidecar already validated this theme on read, but it crossed a
    // process boundary to get here and applyTheme writes it straight into
    // the DOM, so it is re-validated before being trusted.
    const result = validateTheme(raw, { id })
    if (result.ok) return result.theme
  }
  return FALLBACK_THEME
}
