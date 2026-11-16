// Themes kkrpc namespace for user-supplied themes. `list` returns metadata
// plus a six-colour preview (not the full token set); `get` is the separate
// call for the full theme, so the picker does not load every theme's tokens
// just to render its radiogroup.

import { listThemeFiles, readThemeFile, type ThemeEntry } from "../lib/theme-files"
import type { Theme } from "../lib/theme-tokens"

export async function list(): Promise<ThemeEntry[]> {
  return listThemeFiles()
}

/** The full theme, or null when it is missing or invalid. */
export async function get(id: string): Promise<Theme | null> {
  const result = await readThemeFile(id)
  return result.ok ? result.theme : null
}

export type { ThemeEntry }
