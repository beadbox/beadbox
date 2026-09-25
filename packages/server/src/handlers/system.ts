// System sidecar handlers — kkrpc port of actions/system.ts.
//
// Parity contract: every export mirrors actions/system.ts byte-for-byte
// in shape. Logic is platform-dependent (darwin/win32/linux); preserve the
// exact branches so the parity runner in P1.7 sees identical results.
//
// Note: openInFileManager spawns a host UI process (open / explorer.exe /
// xdg-open). The sidecar runs in the same user account as the Tauri host,
// so the spawn surface is the same as the server-action path.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { logPathOverride } from "../lib/log-file"

export async function getLogDirectory(): Promise<string | null> {
  const override = logPathOverride()
  if (override) return path.dirname(override)
  const home = os.homedir()
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Logs", "Beadbox")
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(home, "AppData", "Roaming"),
        "Beadbox",
        "logs",
      )
    case "linux":
      return path.join(home, ".local", "share", "Beadbox", "logs")
    default:
      return null
  }
}

export async function openInFileManager(
  dirPath: string,
): Promise<{ success: boolean; error?: string }> {
  const resolved = path.resolve(dirPath)

  if (!existsSync(resolved)) {
    return { success: false, error: "Directory not found" }
  }

  let command: string
  switch (process.platform) {
    case "darwin":
      command = "open"
      break
    case "win32":
      command = "explorer.exe"
      break
    default:
      command = "xdg-open"
      break
  }

  return new Promise((resolve) => {
    execFile(command, [resolved], (error) => {
      // explorer.exe returns exit code 1 even on success; only treat
      // ENOENT (command not found) as a real failure.
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ success: false, error: error.message })
      } else if (error && process.platform !== "win32") {
        resolve({ success: false, error: error.message })
      } else {
        resolve({ success: true })
      }
    })
  })
}
