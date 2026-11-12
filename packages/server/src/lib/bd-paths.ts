import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export const COMMON_BD_PATHS = [
  "/opt/homebrew/bin/bd",
  "/usr/local/bin/bd",
  "/home/linuxbrew/.linuxbrew/bin/bd",
  join(homedir(), "go/bin/bd"),
  join(homedir(), ".local/bin/bd"),
  ...(process.env.MISE_DATA_DIR ? [join(process.env.MISE_DATA_DIR, "shims/bd")] : []),
  join(homedir(), ".local/share/mise/shims/bd"),
  join(homedir(), ".asdf/shims/bd"),
  join(homedir(), ".nix-profile/bin/bd"),
  "/usr/bin/bd",
  ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Programs", "bd", "bd.exe")] : []),
  join(homedir(), "AppData", "Local", "Programs", "bd", "bd.exe"),
]

let cachedBdPath: string | null = null

export function resolveBdPath(): string {
  if (cachedBdPath) return cachedBdPath
  if (process.env.BD_PATH) {
    cachedBdPath = process.env.BD_PATH
    return cachedBdPath
  }
  for (const p of COMMON_BD_PATHS) {
    if (existsSync(p)) {
      cachedBdPath = p
      return cachedBdPath
    }
  }
  cachedBdPath = "bd"
  return cachedBdPath
}

/** Reset cached paths so Retry re-probes after user installs a tool. */
export function resetPathCaches(): void {
  cachedBdPath = null
}

/** @deprecated Use resetPathCaches(). Kept for existing test imports. */
export const __resetBdPathCache = resetPathCaches
