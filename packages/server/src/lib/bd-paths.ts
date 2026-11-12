import { accessSync, constants, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { validateBdPathStatic } from "./bd-path-validation"
import { readSavedBdPath } from "./bd-preferences"
import { execFileAsync } from "./exec"
import { VERSION_MANAGER_DIRS } from "./tool-paths"
import { compareVersions, MIN_BD_VERSION } from "./version-requirements"

export const COMMON_BD_PATHS = [
  ...VERSION_MANAGER_DIRS.map((dir) => join(dir, "bd")),
  "/opt/homebrew/bin/bd",
  "/usr/local/bin/bd",
  "/home/linuxbrew/.linuxbrew/bin/bd",
  join(homedir(), "go/bin/bd"),
  join(homedir(), ".local/bin/bd"),
  "/usr/bin/bd",
  ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Programs", "bd", "bd.exe")] : []),
  join(homedir(), "AppData", "Local", "Programs", "bd", "bd.exe"),
]

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let cachedBdPath: string | null = null

/** The active executable and why it won; the saved choice remains visible under an env override. */
export function getBdPathSelection(): {
  resolvedPath: string
  source: "environment" | "saved" | "automatic"
  savedPath: string | null
} {
  const savedPath = readSavedBdPath()
  if (process.env.BD_PATH)
    return { resolvedPath: process.env.BD_PATH, source: "environment", savedPath }
  if (savedPath) return { resolvedPath: savedPath, source: "saved", savedPath }
  if (!cachedBdPath) cachedBdPath = COMMON_BD_PATHS.find(isExecutableFile) ?? "bd"
  return { resolvedPath: cachedBdPath, source: "automatic", savedPath: null }
}

/** All bd consumers resolve here at invocation time. */
export function resolveBdPath(): string {
  // An explicit launch override also works if the preferences file is unreadable.
  if (process.env.BD_PATH) return process.env.BD_PATH
  return getBdPathSelection().resolvedPath
}

/** Validate only the selected executable; fixed argv, bounded probe, never a shell. */
export async function validateBdPath(path: string): Promise<string> {
  validateBdPathStatic(path)
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(path, ["--version"], {
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    }))
  } catch {
    throw new Error("Could not read bd version (probe failed or timed out)")
  }
  const version = stdout.match(/\bbd(?: version)?\s+v?(\d+\.\d+\.\d+)\b/i)?.[1]
  if (!version) throw new Error("The executable did not report a bd version")
  if (compareVersions(version, MIN_BD_VERSION) < 0) {
    throw new Error(`bd v${MIN_BD_VERSION} or later is required; found v${version}`)
  }
  return version
}

/** Reset cached paths so Retry re-probes after user installs a tool. */
export function resetPathCaches(): void {
  cachedBdPath = null
}

/** @deprecated Use resetPathCaches(). Kept for existing test imports. */
export const __resetBdPathCache = resetPathCaches
