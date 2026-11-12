// Per-user bd selection; deliberately independent of workspace registries.

import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { validateBdPathStatic } from "./bd-path-validation"

function settingsPath(): string {
  return process.env.BEADBOX_SETTINGS_PATH || join(homedir(), ".beadbox", "settings.json")
}

function readSettings(): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(settingsPath(), "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid settings file")
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    // Do not log file contents or parser messages, which may contain preferences.
    console.warn("[bd:settings] Could not read preferences; ignoring saved bd path")
    return {}
  }
}

/** Recheck untrusted saved data and its current executable target on every read. */
export function readSavedBdPath(): string | null {
  const path = readSettings().bdPath
  if (path === undefined) return null
  try {
    validateBdPathStatic(path)
    return path
  } catch {
    console.warn("[bd:settings] Invalid saved bd path; using automatic detection")
    return null
  }
}

/** Atomically persist a validated path, preserving unrelated preferences. */
export function writeSavedBdPath(path: string | null): void {
  const file = settingsPath()
  const settings = readSettings()
  if (path === null) delete settings.bdPath
  else settings.bdPath = path
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      /* best-effort cleanup; preserve the write error */
    }
    throw error
  }
}
