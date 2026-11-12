import { execFile } from "child_process"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { promisify } from "util"
import { VERSION_MANAGER_DIRS } from "./tool-paths"

// Augment process.env.PATH with common tool directories so child processes
// (bd, dolt) can find binaries regardless of how the Node process was launched.
// On Linux desktop environments and macOS GUI apps (Tauri sidecar), the inherited
// PATH is often stripped to a minimal set that excludes /usr/local/bin, Homebrew
// paths, and user-local install directories.
const COMMON_TOOL_DIRS = [
  ...VERSION_MANAGER_DIRS,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/home/linuxbrew/.linuxbrew/bin",
  join(homedir(), "go/bin"),
  join(homedir(), ".local/bin"),
  join(homedir(), ".dolt/bin"),
]

const currentPath = process.env.PATH ?? ""
const currentDirs = new Set(currentPath.split(":").filter(Boolean))
const missing = [...new Set(COMMON_TOOL_DIRS)].filter((d) => !currentDirs.has(d) && existsSync(d))
if (missing.length > 0) {
  process.env.PATH = `${currentPath}:${missing.join(":")}`
}

export const execFileAsync = promisify(execFile)
export { existsSync } from "fs"
