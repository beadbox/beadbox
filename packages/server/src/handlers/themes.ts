// Themes kkrpc namespace for user-supplied themes. Metadata and full-token reads
// are separate calls so the picker does not load every theme's tokens.

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
