import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export interface BdResolveOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  systemRoot?: string
}

function expandHomeFor(raw: string, home: string): string {
  if (raw === "~") return home
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return join(home, raw.slice(2))
  }
  return raw
}

function cleanAbsoluteDir(raw: string | undefined, home: string): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.includes("\0")) return null
  const expanded = expandHomeFor(trimmed, home)
  if (!isAbsolute(expanded)) return null
  return expanded
}

function cleanUsername(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || /[/\\\0]/.test(trimmed) || trimmed === "." || trimmed === "..") {
    return null
  }
  return trimmed
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return false
    if (platform !== "win32") {
      accessSync(filePath, constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Candidate paths checked during automatic `bd` discovery.
 * Evaluates dynamically from env/home so version-manager overrides like
 * `$MISE_DATA_DIR`, `$ASDF_DATA_DIR`, `$XDG_DATA_HOME`, `$XDG_STATE_HOME`,
 * and `$USER` take effect without relying on login-shell PATH inheritance.
 */
export function getCandidateBdPaths(options: BdResolveOptions = {}): string[] {
  const env = options.env ?? process.env
  const home = options.home ?? (env.HOME?.trim() || homedir())
  const platform = options.platform ?? process.platform
  const systemRoot = options.systemRoot ?? ""
  const bin = platform === "win32" ? "bd.exe" : "bd"
  const sys = (absPath: string) =>
    systemRoot ? join(systemRoot, absPath.replace(/^\/+/, "")) : absPath

  const raw: string[] = [
    sys("/opt/homebrew/bin/bd"),
    sys("/usr/local/bin/bd"),
    sys("/home/linuxbrew/.linuxbrew/bin/bd"),
  ]

  // mise shims ($MISE_DATA_DIR/shims > $XDG_DATA_HOME/mise/shims > ~/.local/share/mise/shims)
  const miseDataDir = cleanAbsoluteDir(env.MISE_DATA_DIR, home)
  if (miseDataDir) raw.push(join(miseDataDir, "shims", bin))
  const xdgDataHome = cleanAbsoluteDir(env.XDG_DATA_HOME, home)
  if (xdgDataHome) raw.push(join(xdgDataHome, "mise", "shims", bin))
  raw.push(join(home, ".local", "share", "mise", "shims", "bd"))

  // asdf shims ($ASDF_DATA_DIR/shims > ~/.asdf/shims)
  const asdfDataDir = cleanAbsoluteDir(env.ASDF_DATA_DIR, home)
  if (asdfDataDir) raw.push(join(asdfDataDir, "shims", bin))
  raw.push(join(home, ".asdf", "shims", "bd"))

  // nix profile locations ($XDG_STATE_HOME/nix/profile/bin > ~/.local/state/nix/profile/bin
  // > ~/.nix-profile/bin > /etc/profiles/per-user/$USER/bin > /nix/var/nix/profiles/default/bin)
  const xdgStateHome = cleanAbsoluteDir(env.XDG_STATE_HOME, home)
  if (xdgStateHome) raw.push(join(xdgStateHome, "nix", "profile", "bin", "bd"))
  raw.push(join(home, ".local", "state", "nix", "profile", "bin", "bd"))
  raw.push(join(home, ".nix-profile", "bin", "bd"))
  const user = cleanUsername(env.USER)
  if (user) raw.push(sys(`/etc/profiles/per-user/${user}/bin/bd`))
  raw.push(sys("/nix/var/nix/profiles/default/bin/bd"))

  // Standard user/system locations
  raw.push(join(home, "go", "bin", "bd"))
  raw.push(join(home, ".local", "bin", "bd"))
  raw.push(sys("/usr/bin/bd"))

  // Windows user locations (mise shims and standalone installer)
  if (env.LOCALAPPDATA && !env.LOCALAPPDATA.includes("\0")) {
    raw.push(join(env.LOCALAPPDATA, "mise", "shims", "bd.exe"))
    raw.push(join(env.LOCALAPPDATA, "Programs", "bd", "bd.exe"))
  }
  raw.push(join(home, "AppData", "Local", "mise", "shims", "bd.exe"))
  raw.push(join(home, "AppData", "Local", "Programs", "bd", "bd.exe"))

  return [...new Set(raw)]
}

export const COMMON_BD_PATHS = getCandidateBdPaths()

let cachedBdPath: string | null = null

export function resolveBdPathWithOptions(options: BdResolveOptions): string {
  const env = options.env ?? process.env
  const home = options.home ?? (env.HOME?.trim() || homedir())
  const platform = options.platform ?? process.platform

  const envOverride = env.BD_PATH?.trim()
  if (envOverride && !envOverride.includes("\0")) {
    return expandHomeFor(envOverride, home)
  }

  for (const candidate of getCandidateBdPaths(options)) {
    if (isExecutableFile(candidate, platform)) {
      return candidate
    }
  }

  return "bd"
}

export function resolveBdPath(): string {
  if (cachedBdPath) return cachedBdPath
  cachedBdPath = resolveBdPathWithOptions({})
  return cachedBdPath
}

/** Reset cached paths so Retry re-probes after user installs a tool. */
export function resetPathCaches(): void {
  cachedBdPath = null
}

/** @deprecated Use resetPathCaches(). Kept for existing test imports. */
export const __resetBdPathCache = resetPathCaches
