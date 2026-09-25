// bd serve (1.3.x) starts a per-workspace `bd db-proxy-child` in its own
// process session, so it survives both bd serve and ServeManager's
// process-group reaping. We are the reason it exists (the CLI alone never
// starts one), so we reap it, but only by ATTRIBUTION, never by pattern
// (sec's ruling on beadbox-6x2, R1-R6):
//
//  R1 Record, don't search: the only candidate is the proxy whose PARENT is
//     our own bd serve, recorded with its pid, start time and command line.
//  R2 Verify before every kill: still alive, our uid, the same start time and
//     command, a db-proxy-child, and --root equal to this workspace's Dolt dir.
//  R3 Live owner: never reap while any live `bd serve` (another instance, or
//     one the user started) serves the same root, or one whose root cannot be
//     determined.
//  R4 One pid at a time: SIGTERM, wait, re-verify, then SIGKILL. Never a
//     process group, never pkill.
//
// The decision is a pure function of a process-table snapshot, so every rule
// is testable without spawning anything.

import { execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

export interface ProcRow {
  pid: number
  ppid: number
  uid: number
  /** ps lstart, e.g. "Fri Sep 25 15:13:48 2026": with the pid, identifies a process instance. */
  start: string
  command: string
}

export interface ProxyRecord {
  pid: number
  start: string
  command: string
  /** realpath of the workspace's .beads/dolt, as passed to the proxy's --root. */
  root: string
}

export type ReapDecision = { reap: true } | { reap: false; reason: string }

/** Parse `ps -axww -o pid=,ppid=,uid=,lstart=,command=`. */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), start: m[4].replace(/\s+/g, " "), command: m[5] })
  }
  return rows
}

const tokens = (command: string) => command.trim().split(/\s+/)

/** realpath when it resolves, else the path as given (compares /var and /private/var alike). */
export function canonical(path: string | null): string | null {
  if (path === null) return null
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The bd subcommand of a command line: the token after the first one named `bd`. */
export function bdSubcommand(command: string): string | null {
  const t = tokens(command)
  const i = t.findIndex((x) => basename(x) === "bd")
  return i >= 0 ? (t[i + 1] ?? null) : null
}

/** The value after a flag, as `--flag value` or `--flag=value`. */
export function argValue(command: string, flag: string): string | null {
  const t = tokens(command)
  for (let i = 0; i < t.length; i++) {
    if (t[i] === flag) return t[i + 1] ?? null
    if (t[i].startsWith(`${flag}=`)) return t[i].slice(flag.length + 1)
  }
  return null
}

/** R1: the db-proxy-child whose parent is OUR bd serve, for this root. */
export function findOurProxy(rows: ProcRow[], servePid: number, root: string): ProxyRecord | null {
  const row = rows.find(
    (r) =>
      r.ppid === servePid && bdSubcommand(r.command) === "db-proxy-child" && canonical(argValue(r.command, "--root")) === root,
  )
  return row ? { pid: row.pid, start: row.start, command: row.command, root } : null
}

/** Our bd serve: the wrapper's child running `bd serve`. */
export function findServePid(rows: ProcRow[], wrapperPid: number): number | null {
  return rows.find((r) => r.ppid === wrapperPid && bdSubcommand(r.command) === "serve")?.pid ?? null
}

/** The .beads/dolt a bd started in `dir` would use: bd walks up from its directory to find .beads. */
export function doltRootFrom(dir: string): string | null {
  let d = resolve(dir)
  for (;;) {
    const candidate = join(d, ".beads", "dolt")
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate)
      } catch {
        return null
      }
    }
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

/**
 * R3: the root each live `bd serve` serves; null when it cannot be told
 * (an explicit --db, an unreadable working directory), which blocks a reap.
 */
export function liveServeRoots(rows: ProcRow[], cwdOf: (pid: number) => string | null): Array<string | null> {
  return rows
    .filter((r) => bdSubcommand(r.command) === "serve")
    .map((r) => {
      if (argValue(r.command, "--db") !== null) return null
      const dir = argValue(r.command, "-C") ?? argValue(r.command, "--directory")
      const base = cwdOf(r.pid)
      if (!base) return null
      return doltRootFrom(dir ? (isAbsolute(dir) ? dir : resolve(base, dir)) : base)
    })
}

/** R2 + R3: may this recorded proxy be reaped right now? */
export function proxyReapDecision(
  rec: ProxyRecord,
  rows: ProcRow[],
  uid: number,
  serveRoots: Array<string | null>,
): ReapDecision {
  const row = rows.find((r) => r.pid === rec.pid)
  if (!row) return { reap: false, reason: "gone" }
  if (row.uid !== uid) return { reap: false, reason: "another user's process" }
  if (row.start !== rec.start || row.command !== rec.command) return { reap: false, reason: "pid reused by another process" }
  if (bdSubcommand(row.command) !== "db-proxy-child" || canonical(argValue(row.command, "--root")) !== rec.root) {
    return { reap: false, reason: "not this workspace's proxy" }
  }
  if (serveRoots.includes(null)) return { reap: false, reason: "a live bd serve with an unknown root" }
  if (serveRoots.includes(rec.root)) return { reap: false, reason: "a live bd serve still uses this root" }
  return { reap: true }
}

// ---------------------------------------------------------------------------
// I/O: a process-table snapshot, a working directory, and the reap itself.

export function processTable(): ProcRow[] {
  return parsePs(execFileSync("ps", ["-axww", "-o", "pid=,ppid=,uid=,lstart=,command="], { encoding: "utf-8" }))
}

export function cwdOf(pid: number): string | null {
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf-8" })
    const line = out.split("\n").find((l) => l.startsWith("n"))
    return line ? line.slice(1) : null
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * R4: reap one recorded proxy if R2 + R3 allow it. SIGTERM, wait up to
 * `waitMs`, re-verify (R2 again, in case the pid was reused while waiting),
 * then SIGKILL. Returns what happened, for the log.
 */
export async function reapRecordedProxy(rec: ProxyRecord, waitMs = 3000): Promise<string> {
  const uid = process.getuid?.() ?? -1
  const decide = () => {
    const rows = processTable()
    return proxyReapDecision(rec, rows, uid, liveServeRoots(rows, cwdOf))
  }
  const first = decide()
  if (!first.reap) return `left (${first.reason})`
  process.kill(rec.pid, "SIGTERM")
  const end = Date.now() + waitMs
  while (Date.now() < end && alive(rec.pid)) await new Promise((r) => setTimeout(r, 50))
  if (!alive(rec.pid)) return "reaped (SIGTERM)"
  const again = decide()
  if (!again.reap) return `left after SIGTERM (${again.reason})`
  process.kill(rec.pid, "SIGKILL")
  return "reaped (SIGKILL)"
}
