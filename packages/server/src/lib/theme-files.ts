// Reads user theme files from ~/.beadbox/themes/*.json.
//
// Location mirrors getBeadboxRegistryPath() in workspace-registry.ts:
// same ~/.beadbox directory, same env-var override for test isolation.
// Reading happens here, in the sidecar, so no Tauri fs: capability is needed
// — the webview never touches the filesystem.

import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { Theme } from "./theme-tokens"
import { validateTheme } from "./theme-validate"

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface ThemeEntry {
  id: string
  name: string
  appearance: "dark" | "light"
  source: "user"
  error?: string
  /**
   * Six colours for the picker's mini-UI preview, not the full token set —
   * metadata and full-token reads stay separate calls (see handlers/themes.ts).
   * Absent when the theme failed validation: there is nothing to preview.
   */
  preview?: Pick<
    Theme["colors"],
    "background" | "card" | "primary" | "secondary" | "mutedForeground" | "foreground"
  >
}

/** Respects BEADBOX_THEMES_PATH for test isolation. */
export function getThemesDir(): string {
  return process.env.BEADBOX_THEMES_PATH || join(homedir(), ".beadbox", "themes")
}

export async function listThemeFiles(): Promise<ThemeEntry[]> {
  const dir = getThemesDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // No themes directory yet is the normal first-run state, not an error.
    return []
  }

  const entries: ThemeEntry[] = []
  for (const fileName of names.sort()) {
    if (!fileName.endsWith(".json")) continue
    const id = basename(fileName, ".json")

    let raw: string
    try {
      raw = await readFile(join(dir, fileName), "utf-8")
    } catch {
      continue // a subdirectory named "*.json" or an unreadable entry
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      entries.push({
        id,
        name: id,
        appearance: "dark",
        source: "user",
        error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }

    const result = validateTheme(parsed, { id })
    if (!result.ok) {
      entries.push({ id, name: id, appearance: "dark", source: "user", error: result.error })
      continue
    }
    // Metadata plus a six-colour preview — not the full token set, so the
    // picker still does not pay for every theme's tokens.
    const { background, card, primary, secondary, mutedForeground, foreground } =
      result.theme.colors
    entries.push({
      id: result.theme.id,
      name: result.theme.name,
      appearance: result.theme.appearance,
      source: "user",
      preview: { background, card, primary, secondary, mutedForeground, foreground },
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
