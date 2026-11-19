// Reads user theme files from ~/.beadbox/themes/*.json.
//
// Location mirrors getBeadboxRegistryPath() in workspace-registry.ts:
// same ~/.beadbox directory, same env-var override for test isolation.
// Reading happens here, in the sidecar, so no Tauri fs: capability is needed
// — the webview never touches the filesystem.

import { type FSWatcher, watch } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { Appearance, Theme } from "./theme-tokens"
import { validateTheme } from "./theme-validate"

// Editors write in several steps (temp file, rename, chmod), so a single
// save still produces several raw fs events. This debounce coalesces them
// into one onChange() call. 200ms is comfortably larger than the span of a
// typical multi-step atomic save (observed within tens of ms) while still
// feeling instant to a user who just hit save.
const WATCH_DEBOUNCE_MS = 200

// Deliberately NOT theme-tokens.ts's THEME_ID_RE: this copy gates a
// filesystem path (readThemeFile builds `${id}.json` from it before ever
// touching disk), and stays independent as defence-in-depth. Do not "DRY"
// it away into the shared constant — a future relaxation of the shared
// format must not silently widen what this one lets through to a path.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface ThemeEntry {
  id: string
  name: string
  /**
   * Null when the file's own declared appearance could not be recovered
   * — unparseable JSON, or any other shape
   * that never reached the point where `appearance` could be read. Always
   * paired with `error` set: a null-appearance entry can never be slotted,
   * only shown with its error outside both the dark and light grids, so the
   * symptom (an invalid light theme) and the diagnosis never end up filed
   * under the wrong heading.
   */
  appearance: Appearance | null
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

/**
 * The file's own declared `appearance`, read directly off the still-unvalidated
 * parsed JSON — used when full validation fails for some OTHER reason (bad
 * colours, wrong id, ...) but the appearance field itself is a usable value.
 * Returns null for anything that isn't exactly "dark" or "light", including
 * a non-object or an absent field — never a guess.
 */
function declaredAppearance(parsed: unknown): Appearance | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const appearance = (parsed as Record<string, unknown>).appearance
  return appearance === "dark" || appearance === "light" ? appearance : null
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
        // Unparseable text has no recoverable appearance to read — null,
        // not a guess: guessing "dark"
        // here is exactly what put a broken light theme's error under the
        // Dark heading while the Light grid showed nothing wrong.
        appearance: null,
        source: "user",
        error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }

    const result = validateTheme(parsed, { id })
    if (!result.ok) {
      entries.push({
        id,
        name: id,
        // Validation can fail on anything (id, name, colours, ...) without
        // the declared appearance itself being wrong, so preserve it when
        // the raw (not-yet-validated) JSON names a usable one — the error
        // then lands in the grid for the slot it actually claims.
        appearance: declaredAppearance(parsed),
        source: "user",
        error: result.error,
      })
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

/**
 * Watch the themes directory for changes, debouncing bursts into one
 * onChange() call. Node's FSWatcher emits only "change", "error" and
 * "close" — the "rename" vs "change" distinction arrives as the FIRST
 * ARGUMENT to the "change" listener, not as a separate event name, so a
 * single listener handles a file being created, edited or deleted alike.
 *
 * A half-written file mid-save is not a bad file: this watcher only
 * signals "something changed, go re-read" — it never classifies, moves or
 * renames anything itself. Reporting bad themes in place is
 * listThemeFiles()'s job.
 *
 * Returns a stop function; a missing directory yields a no-op stop.
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
    timer = setTimeout(onChange, WATCH_DEBOUNCE_MS)
  })
  watcher.on("error", () => {
    /* a vanished directory is not fatal */
  })
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    watcher.close()
  }
}
