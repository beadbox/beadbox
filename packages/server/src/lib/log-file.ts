// bb-pnk0: tee sidecar stderr to a file in the platform-canonical log dir
// so ops can grep production failures without depending on macOS unified
// log (which quarantines under high volume — burned us during bb-pnlx).
//
// Channel discipline contract is unchanged: stdout is still the kkrpc wire,
// nothing here writes to it. This module ONLY mirrors stderr writes to a
// log file. Callers shouldn't import this directly — console-discipline
// installs the mirror at boot, then the existing console.error /
// process.stderr.write paths produce file content for free.

import { closeSync, fstatSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/**
 * BEADBOX_LOG_PATH, when set to an absolute path. Side-by-side builds
 * (scripts/build-local-macos.sh) point it at a scratch file so they never
 * share the installed app's log. Relative values are ignored: the sidecar's
 * cwd is not something the launcher controls.
 */
export function logPathOverride(): string | null {
  const override = process.env.BEADBOX_LOG_PATH
  return override && isAbsolute(override) ? override : null
}

function resolveLogPath(): string {
  const override = logPathOverride()
  if (override) return override
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Logs", "Beadbox", "beadbox-sidecar.log")
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    return join(localAppData, "Beadbox", "Logs", "beadbox-sidecar.log")
  }
  // Linux + everything else: XDG_STATE_HOME with the spec's fallback.
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(stateHome, "beadbox", "beadbox-sidecar.log")
}

let logFd: number | null = null
let logPath: string | null = null
let openFailed = false

// beadbox-01f.4: the log is append-only (#41), so it is bounded by rotation:
// past maxBytes the file is renamed to <log>.1 (replacing any older .1) and a
// new one is started, keeping two generations. Checked at boot and every
// checkEvery writes, which also catches growth from the other appenders to
// the same file (a second sidecar, the poll child's shell tee).
let maxBytes = 5 * 1024 * 1024
let checkEvery = 200
let writesSinceCheck = 0

/** Test seam: shrink the cap / check interval so rotation is observable. */
export function _setLogRotationForTests(opts: { maxBytes?: number; checkEvery?: number }): void {
  if (opts.maxBytes !== undefined) maxBytes = opts.maxBytes
  if (opts.checkEvery !== undefined) checkEvery = opts.checkEvery
}

function openAt(path: string, header: string): number {
  mkdirSync(join(path, ".."), { recursive: true })
  // O_APPEND keeps concurrent Production and Local sidecars from overwriting
  // each other's log entries and leaves no pending flush promise at exit.
  const fd = openSync(path, "a")
  writeSync(fd, header)
  return fd
}

function openWriter(): number | null {
  if (logFd !== null || openFailed) return logFd
  try {
    logPath = resolveLogPath()
    logFd = openAt(
      logPath,
      `\n--- ${new Date().toISOString()} sidecar boot pid=${process.pid} ---\n`,
    )
    maintainLog()
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

/**
 * Follow a rotation made by another instance (our fd no longer names the file
 * at the path) and rotate when the file is over the cap. Never throws: a
 * failed rename (e.g. Windows with the file held open) just skips this round.
 */
function maintainLog(): void {
  if (logFd === null || logPath === null) return
  try {
    const onDisk = statFile(logPath)
    const ours = fstatSync(logFd)
    if (!onDisk || onDisk.ino !== ours.ino || onDisk.dev !== ours.dev) {
      reopen(
        `\n--- ${new Date().toISOString()} log reopened after rotation pid=${process.pid} ---\n`,
      )
      return
    }
    if (onDisk.size <= maxBytes) return
    renameSync(logPath, `${logPath}.1`)
    reopen(`\n--- ${new Date().toISOString()} log rotated pid=${process.pid} ---\n`)
  } catch {
    /* rotation is best-effort; logging continues on the current fd */
  }
}

function statFile(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function reopen(header: string): void {
  if (logPath === null) return
  const previous = logFd
  logFd = openAt(logPath, header)
  if (previous !== null) {
    try {
      closeSync(previous)
    } catch {
      /* already closed */
    }
  }
}

/**
 * The log file path, once the file sink is open; null when it is unavailable.
 * The server-mode poll child appends its own [SUBSCRIPTION:] lines here.
 */
export function activeLogPath(): string | null {
  return openWriter() === null ? null : logPath
}

export function logFileWrite(line: string): void {
  const fd = openWriter()
  if (fd === null) return
  if (++writesSinceCheck >= checkEvery) {
    writesSinceCheck = 0
    maintainLog()
  }
  try {
    writeSync(logFd ?? fd, line.endsWith("\n") ? line : `${line}\n`)
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
