// Themes kkrpc namespace for user-supplied themes. `list` returns metadata
// plus a six-colour preview (not the full token set); `get` is the separate
// call for the full theme, so the picker does not load every theme's tokens
// just to render its radiogroup.

import { listThemeFiles, readThemeFile, type ThemeEntry, watchThemes } from "../lib/theme-files"
import type { Theme } from "../lib/theme-tokens"

export async function list(): Promise<ThemeEntry[]> {
  return listThemeFiles()
}

/** The full theme, or null when it is missing or invalid. */
export async function get(id: string): Promise<Theme | null> {
  const result = await readThemeFile(id)
  return result.ok ? result.theme : null
}

let stopWatcher: (() => void) | null = null

/**
 * Starts watching the themes directory. On every debounced change, emits a
 * `[THEMES:changed]` line on stderr — the same channel subscribe.ts's
 * `[SUBSCRIPTION:<id>]` stream uses, so hot reload needs no new transport,
 * just a line prefix the client-side listener filters on. Idempotent: a
 * second call restarts the watcher rather than stacking a second one (e.g.
 * a second renderer window, or a remount of the hook that owns it).
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

export type { ThemeEntry }
