// Supervises `bd serve` children for workspaces that opted in to serve reads
// (beadbox-6x2, landing L2). Spawn, lifetime and token only: nothing here
// makes an HTTP request, and nothing in the app constructs a manager until
// read routing lands (L4).
//
// Security conditions (sec, beadbox-6x2):
//  C1  bd serve binds an explicit loopback address (--addr 127.0.0.1:0), and
//      the first stdout line must be exactly "bd serve: listening on
//      http://127.0.0.1:<port>"; anything else is a startup failure.
//  C2  a fresh 32-byte token per spawn, in a mkdtemp dir (0700) as a 0600 file
//      written with 'wx'; removed when the child ends, however the sidecar
//      ends; the startup sweep removes only our own stale dirs.
//
// Lifetime: the same tie as the server-mode poll child (beadbox-db6). The
// child is a /bin/sh wrapper whose stdin is a pipe the sidecar holds and
// never writes. When the sidecar exits for any reason, including SIGKILL,
// the kernel closes that pipe; the wrapper reads EOF, removes the token dir,
// and signals its own process group, bd serve included.
//
// No timers: the sidecar's stdin reader can gate timers on its main thread
// (see CLAUDE.md, sidecar gotchas), so idle stop and restart backoff are
// evaluated on each access instead of scheduled.

import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  canonical,
  findOurProxy,
  findServePid,
  type ProxyRecord,
  processTable,
  reapRecordedProxy,
} from "./serve-proxy"

export const SERVE_DIR_PREFIX = "beadbox-serve-"
/** A recorded proxy (serve-proxy.ts) waiting to be reaped; kept after the token is removed. */
export const PROXY_RECORD = "proxy.json"
const LISTENING = /^bd serve: listening on (http:\/\/127\.0\.0\.1:(\d{1,5}))$/
const STARTUP_TIMEOUT_MS = 10_000
const STOP_WAIT_MS = 5_000
export const MAX_CHILDREN = 3
export const IDLE_STOP_MS = 5 * 60_000
const BACKOFF_MIN_MS = 250
const BACKOFF_MAX_MS = 8_000

/** The only variables a serve child inherits besides its own workspace's Dolt settings. */
const BASE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG"] as const
const WORKSPACE_ENV = /^BEADS_DOLT_[A-Z_]+$/

export interface ServeTarget {
  /** Registry id of the workspace. */
  key: string
  /** Workspace root (the directory holding .beads); bd serve's working directory. */
  workspaceDir: string
  /** This workspace's Dolt settings (BEADS_DOLT_*); anything else is dropped. */
  env: Record<string, string>
}

export interface ServeHandle {
  key: string
  url: string
  /** Held in memory for the HTTP client (L3); never logged, never in argv or env. */
  token: string
  pid: number
}

/**
 * The /bin/sh argv for a serve child. The script is a constant (the only
 * interpolation is the module constant SERVE_DIR_PREFIX): the bd path and
 * token dir arrive as positionals and are only ever read through quoted
 * variables, so no caller-supplied text is spliced into shell code. The
 * cleanup refuses to remove anything whose LAST path component is not named
 * like our token dirs (a matching parent directory does not count).
 */
export function buildServeShellArgs(bdPath: string, tokenDir: string): string[] {
  const SCRIPT = `
exec 3<&0 </dev/null
BD="$1"
TOKDIR="$2"
cleanup() { case "\${TOKDIR##*/}" in ${SERVE_DIR_PREFIX}*) rm -f -- "$TOKDIR/token"; [ -e "$TOKDIR/${PROXY_RECORD}" ] || rm -rf -- "$TOKDIR" ;; esac; }
( while read -r _ <&3; do :; done; cleanup; kill -TERM -$$ 2>/dev/null || kill -TERM $$ ) &
exec 3<&-
"$BD" serve --addr 127.0.0.1:0 --auth-token-file "$TOKDIR/token" &
wait $!
cleanup
kill -TERM -$$ 2>/dev/null || kill -TERM $$
`
  return ["-c", SCRIPT, "bd-serve", bdPath, tokenDir]
}

/** C1: accept only the exact loopback listening line. */
export function parseListeningLine(line: string): { url: string; port: number } | null {
  const m = LISTENING.exec(line)
  if (!m) return null
  const port = Number(m[2])
  return port > 0 && port < 65536 ? { url: m[1], port } : null
}

/** The child's whole environment: a few base variables plus this workspace's Dolt settings. */
export function serveChildEnv(target: ServeTarget, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of BASE_ENV_KEYS) if (parent[k] !== undefined) env[k] = parent[k]
  for (const [k, v] of Object.entries(target.env)) if (WORKSPACE_ENV.test(k)) env[k] = v
  return env
}

/** C2: a fresh token in a new private dir. The caller owns removal (the shell wrapper does it). */
export function createTokenDir(root: string = tmpdir()): { dir: string; token: string } {
  // The creating sidecar's pid is in the name, so a sweep by ANOTHER running
  // instance (a side-by-side app sharing TMPDIR) can tell our live dirs apart.
  const dir = mkdtempSync(join(root, `${SERVE_DIR_PREFIX}${process.pid}-`))
  chmodSync(dir, 0o700)
  const token = randomBytes(32).toString("base64url")
  writeFileSync(join(dir, "token"), `${token}\n`, { mode: 0o600, flag: "wx" })
  return { dir, token }
}

/**
 * Remove serve token dirs left by a sidecar that died before its wrappers
 * could clean up. Only entries directly under `root` named
 * beadbox-serve-<pid>-*, whose pid is NOT a live process (another running
 * instance's dirs are left alone), that are real directories (lstat: symlinks
 * are never followed), owned by our uid, and not in use by a live child of
 * ours. A name without a pid cannot be attributed and is left alone.
 */
const OWNER_PID = new RegExp(`^${SERVE_DIR_PREFIX}(\\d+)-`)

/** True if the pid is a live process, including one we may not signal. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function sweepStaleServeDirs(
  root: string = tmpdir(),
  inUse: ReadonlySet<string> = new Set(),
  uid: number = process.getuid?.() ?? -1,
): string[] {
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return removed
  }
  for (const name of names) {
    const owner = OWNER_PID.exec(name)
    if (!owner) continue
    const path = join(root, name)
    if (inUse.has(path) || processAlive(Number(owner[1]))) continue
    try {
      const st = lstatSync(path)
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) continue
      if (existsSync(join(path, PROXY_RECORD))) continue // sweepStaleServeProxies reaps it first
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    } catch {
      /* raced away or unreadable: leave it */
    }
  }
  return removed
}

/**
 * The startup half of R4: for stale token dirs of DEAD sidecars that still
 * hold a proxy record, reap that recorded proxy (R2 + R3 decide), then remove
 * the dir. Same attribution rules as sweepStaleServeDirs.
 */
export async function sweepStaleServeProxies(
  root: string = tmpdir(),
  inUse: ReadonlySet<string> = new Set(),
  uid: number = process.getuid?.() ?? -1,
): Promise<string[]> {
  const outcomes: string[] = []
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return outcomes
  }
  for (const name of names) {
    const owner = OWNER_PID.exec(name)
    const path = join(root, name)
    if (!owner || inUse.has(path) || processAlive(Number(owner[1]))) continue
    try {
      const st = lstatSync(path)
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) continue
      const recFile = join(path, PROXY_RECORD)
      if (!existsSync(recFile)) continue
      const rec = JSON.parse(readFileSync(recFile, "utf-8")) as ProxyRecord
      outcomes.push(`${rec.pid}: ${await reapRecordedProxy(rec)}`)
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* unreadable record or raced away: leave it */
    }
  }
  return outcomes
}

interface Child {
  handle: ServeHandle
  process: ChildProcess
  tokenDir: string
  workspaceDir: string
  lastUsed: number
  proxy: ProxyRecord | null
}

export interface ServeManagerOptions {
  bdPath: () => string
  now?: () => number
  tokenRoot?: string
}

export class ServeManager {
  private readonly children = new Map<string, Child>()
  private readonly failures = new Map<string, { count: number; notBefore: number }>()
  private readonly now: () => number

  constructor(private readonly opts: ServeManagerOptions) {
    if (process.platform === "win32") throw new Error("bd serve reads are not supported on Windows")
    this.now = opts.now ?? Date.now
  }

  /** A running child for this workspace, starting one if needed. Throws to mean "use the CLI". */
  async get(target: ServeTarget): Promise<ServeHandle> {
    this.stopIdle()
    const existing = this.children.get(target.key)
    if (existing && existing.process.exitCode === null && existing.process.signalCode === null) {
      existing.lastUsed = this.now()
      return existing.handle
    }
    const backoff = this.failures.get(target.key)
    if (backoff && this.now() < backoff.notBefore) throw new Error("bd serve: restart backoff")
    if (this.children.size >= MAX_CHILDREN) await this.stop(this.leastRecentlyUsed())
    try {
      const child = await this.start(target)
      this.failures.delete(target.key)
      return child.handle
    } catch (error) {
      const count = (backoff?.count ?? 0) + 1
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (count - 1))
      this.failures.set(target.key, { count, notBefore: this.now() + delay })
      throw error
    }
  }

  /** Dirs belonging to live children, so the sweep never touches them. */
  liveTokenDirs(): Set<string> {
    return new Set([...this.children.values()].map((c) => c.tokenDir))
  }

  async stop(key: string | undefined): Promise<void> {
    if (!key) return
    const child = this.children.get(key)
    if (!child) return
    this.children.delete(key)
    recordProxy(child)
    await endChild(child.process)
    // The exit handler also runs finishChild; both are idempotent. Awaiting it
    // here means a stop returns only once the proxy decision is made and the
    // token dir is gone (the wrapper may have been SIGKILLed before it could).
    await finishChild(child)
  }

  /** Called once reads are flowing: the proxy exists by now, so record it (R1). */
  noteHealthy(key: string): void {
    const child = this.children.get(key)
    if (child) recordProxy(child)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.children.keys()].map((k) => this.stop(k)))
  }

  private stopIdle(): void {
    const cutoff = this.now() - IDLE_STOP_MS
    for (const [key, child] of this.children) {
      if (child.lastUsed < cutoff) void this.stop(key)
    }
  }

  private leastRecentlyUsed(): string | undefined {
    let oldest: Child | undefined
    for (const c of this.children.values()) if (!oldest || c.lastUsed < oldest.lastUsed) oldest = c
    return oldest?.handle.key
  }

  private async start(target: ServeTarget): Promise<Child> {
    const { dir, token } = createTokenDir(this.opts.tokenRoot)
    let proc: ChildProcess
    try {
      proc = spawnServeChild(this.opts.bdPath(), dir, target)
    } catch (error) {
      removeTokenDir(dir)
      throw error
    }
    try {
      const { url } = await readListeningLine(proc)
      if (proc.pid === undefined) throw new Error("bd serve: no pid")
      const child: Child = {
        handle: { key: target.key, url, token, pid: proc.pid },
        process: proc,
        tokenDir: dir,
        workspaceDir: target.workspaceDir,
        lastUsed: this.now(),
        proxy: null,
      }
      // The moment the child exits, for any reason: drop its address, so no
      // caller can reach a port another process may since have taken, and
      // remove its token dir. The wrapper normally removes it, but not if its
      // whole group was SIGKILLed (by a stop that had to escalate, or from
      // outside).
      proc.once("exit", () => {
        if (this.children.get(target.key) === child) this.children.delete(target.key)
        void finishChild(child)
      })
      this.children.set(target.key, child)
      recordProxy(child)
      return child
    } catch (error) {
      await endChild(proc)
      removeTokenDir(dir)
      throw error
    }
  }
}

/**
 * The one place a serve child is spawned (reviewed in bd-spawn-census). stdin
 * is the lifetime pipe; detached gives the wrapper its own process group so
 * its EOF handler, and stop(), can end bd serve with it.
 */
function spawnServeChild(bdPath: string, tokenDir: string, target: ServeTarget): ChildProcess {
  return spawn("/bin/sh", buildServeShellArgs(bdPath, tokenDir), {
    cwd: target.workspaceDir,
    env: serveChildEnv(target),
    stdio: ["pipe", "pipe", "ignore"],
    detached: true,
  })
}

/**
 * R1: record the db-proxy-child whose parent is OUR bd serve, while that
 * serve is still alive. Best effort and idempotent; persisted beside the
 * token so a sidecar that dies can still have it reaped at the next start.
 */
function recordProxy(child: Child): void {
  if (child.proxy) return
  try {
    const rows = processTable()
    const servePid = findServePid(rows, child.handle.pid)
    const root = canonical(join(child.workspaceDir, ".beads", "dolt"))
    if (!servePid || !root) return
    const rec = findOurProxy(rows, servePid, root)
    if (!rec) return
    child.proxy = rec
    writeFileSync(join(child.tokenDir, PROXY_RECORD), JSON.stringify(rec), { mode: 0o600 })
  } catch {
    /* no record: nothing of ours to reap */
  }
}

const finishing = new WeakMap<Child, Promise<void>>()

/** After our serve is gone: reap our recorded proxy (R2-R4 decide), then remove the token dir. */
function finishChild(child: Child): Promise<void> {
  let done = finishing.get(child)
  if (!done) {
    done = (async () => {
      if (child.proxy) {
        const outcome = await reapRecordedProxy(child.proxy).catch((e) => `error: ${String(e)}`)
        console.error(`[serve-manager] proxy ${child.proxy.pid} for ${child.handle.key}: ${outcome}`)
      }
      removeTokenDir(child.tokenDir)
    })()
    finishing.set(child, done)
  }
  return done
}

/** Remove one of our token dirs; refuses any path whose own name lacks our prefix. */
function removeTokenDir(dir: string): void {
  if (basename(dir).startsWith(SERVE_DIR_PREFIX)) rmSync(dir, { recursive: true, force: true })
}

function readListeningLine(proc: ChildProcess): Promise<{ url: string; port: number }> {
  return new Promise((resolve, reject) => {
    let buf = ""
    const fail = (why: string) => {
      cleanup()
      reject(new Error(`bd serve: ${why}`))
    }
    const onData = (d: Buffer) => {
      buf += d.toString()
      const nl = buf.indexOf("\n")
      if (nl < 0) {
        if (buf.length > 4096) fail("no listening line")
        return
      }
      const parsed = parseListeningLine(buf.slice(0, nl))
      cleanup()
      if (parsed) resolve(parsed)
      else reject(new Error("bd serve: unexpected first stdout line"))
    }
    const onExit = () => fail("exited before listening")
    const timer = setTimeout(() => fail("no listening line within 10s"), STARTUP_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      proc.stdout?.off("data", onData)
      proc.off("exit", onExit)
    }
    proc.stdout?.on("data", onData)
    proc.once("exit", onExit)
  })
}

/** Close the wrapper's stdin (it removes the token dir and ends its group), then wait. */
async function endChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()))
  proc.stdin?.destroy()
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STOP_WAIT_MS)),
  ])
  if (timedOut && proc.pid) {
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
}
