import { execFile } from "child_process"
import { existsSync } from "fs"
import { homedir } from "os"
import { delimiter, isAbsolute, join } from "path"
import { promisify } from "util"

// Augment process.env.PATH with common tool directories so child processes
// (bd, dolt, and shell-based mise/asdf shims) can find binaries regardless of
// how the sidecar process was launched. On Linux desktop environments and macOS
// GUI apps, the inherited PATH excludes Homebrew, version-manager shims, and
// user-local install directories.
function buildCommonToolDirs(): string[] {
  const home = process.env.HOME?.trim() || homedir()
  const expand = (val: string | undefined): string | null => {
    if (!val) return null
    const trimmed = val.trim()
    if (!trimmed || trimmed.includes("\0")) return null
    const resolved =
      trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed
    return isAbsolute(resolved) ? resolved : null
  }

  const miseData = expand(process.env.MISE_DATA_DIR)
  const xdgData = expand(process.env.XDG_DATA_HOME)
  const asdfData = expand(process.env.ASDF_DATA_DIR)
  const xdgState = expand(process.env.XDG_STATE_HOME)
  const user = process.env.USER?.trim()
  const safeUser = user && !/[/\\\0]/.test(user) && user !== "." && user !== ".." ? user : null

  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    ...(miseData ? [join(miseData, "shims")] : []),
    ...(xdgData ? [join(xdgData, "mise", "shims")] : []),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".local", "share", "mise", "bin"),
    ...(asdfData ? [join(asdfData, "shims")] : []),
    join(home, ".asdf", "shims"),
    join(home, ".asdf", "bin"),
    ...(xdgState ? [join(xdgState, "nix", "profile", "bin")] : []),
    join(home, ".local", "state", "nix", "profile", "bin"),
    join(home, ".nix-profile", "bin"),
    ...(safeUser ? [`/etc/profiles/per-user/${safeUser}/bin`] : []),
    "/nix/var/nix/profiles/default/bin",
    join(home, "go/bin"),
    join(home, ".local/bin"),
    join(home, ".dolt/bin"),
  ]
}

const currentPath = process.env.PATH ?? ""
const currentDirs = new Set(currentPath.split(delimiter).filter(Boolean))
const missing = [...new Set(buildCommonToolDirs())].filter(
  (d) => !currentDirs.has(d) && existsSync(d),
)
if (missing.length > 0) {
  process.env.PATH = currentPath
    ? `${currentPath}${delimiter}${missing.join(delimiter)}`
    : missing.join(delimiter)
}

export const execFileAsync = promisify(execFile)
export { existsSync } from "fs"
