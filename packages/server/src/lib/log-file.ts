// bb-pnk0: tee sidecar stderr to a file in the platform-canonical log dir
// so ops can grep production failures without depending on macOS unified
// log (which quarantines under high volume — burned us during bb-pnlx).
//
// Channel discipline contract is unchanged: stdout is still the kkrpc wire,
// nothing here writes to it. This module ONLY mirrors stderr writes to a
// log file. Callers shouldn't import this directly — console-discipline
// installs the mirror at boot, then the existing console.error /
// process.stderr.write paths produce file content for free.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function getSidecarLogDirectory(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Logs", "Beadbox")
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    return join(localAppData, "Beadbox", "Logs")
  }
  // Linux + everything else: XDG_STATE_HOME with the spec's fallback.
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(stateHome, "beadbox")
}

function resolveLogPath(): string {
  return join(getSidecarLogDirectory(), "beadbox-sidecar.log")
}

let logFd: number | null = null
let openFailed = false

function openWriter(): number | null {
  if (logFd !== null || openFailed) return logFd
  try {
    const path = resolveLogPath()
    mkdirSync(join(path, ".."), { recursive: true })
    // O_APPEND keeps concurrent Production and Local sidecars from overwriting
    // each other's log entries and leaves no pending flush promise at exit.
    logFd = openSync(path, "a")
    writeSync(logFd, `\n--- ${new Date().toISOString()} sidecar boot pid=${process.pid} ---\n`)
  } catch (err) {
    openFailed = true
    // One-time stderr warning so the operator knows the file sink is dead.
    // Do NOT use console.error here — discipline.ts wraps that and would
    // re-enter this function. Direct write to the underlying stderr fd.
    process.stderr.write(
      `[beadbox-sidecar] log file unavailable, stderr-only mode: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
  return logFd
}

export function logFileWrite(line: string): void {
  const fd = openWriter()
  if (fd === null) return
  try {
    writeSync(fd, line.endsWith("\n") ? line : `${line}\n`)
  } catch {
    // Disk full / handle closed mid-process — give up silently. Stderr
    // already has the line via the discipline.ts mirror; logging failure
    // must never crash the sidecar.
  }
}

export function closeLogFile(): void {
  if (logFd === null) return
  try {
    closeSync(logFd)
  } catch {
    /* best-effort close on shutdown */
  }
  logFd = null
}
