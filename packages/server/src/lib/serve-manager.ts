import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { bdServeStderrLogEnabled } from "./app-config"
import { resolveBdPath } from "./bd-paths"
import { buildServerEnv, getWorkspacePassword } from "./credential-provider"
import { requestServeJson, type ServeHandle, ServeHttpError, ServeHttpSession } from "./serve-http"
import { ServeStderrLog } from "./serve-stderr-log"
import { resolveWorkspaceTarget, type WorkspaceTarget } from "./workspace-resolver"
import { workspaceTransition } from "./workspace-transition"

interface OwnedProcess {
  readonly target: WorkspaceTarget
  readonly child: ChildProcess
  readonly runtimeDir: string
  readonly address: string
  readonly token: string
  session: ServeHttpSession | null
  inFlight: number
  draining: boolean
  lastUsed: number
  waiters: Array<() => void>
}

const STARTUP_MS = 10_000
const DRAIN_MS = 25_000 // Keep the full stop inside the sidecar and Tauri 30-second watchdogs.
const MAX_SERVERS = 3
const IDLE_MS = 5 * 60_000
const START_LINE = /^bd serve: listening on (http:\/\/127\.0\.0\.1:([1-9]\d{0,4}))$/

function key(target: WorkspaceTarget): string {
  return `${target.id}:${target.generation}`
}

function diagnosticErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown"
}

// The npm bd.js shim spawns the native bd process. Signalling the shim can
// orphan a listening server, so own the native process directly when present.
export function resolveServeBinary(binary: string): string {
  let resolved: string
  try {
    resolved = realpathSync(binary)
  } catch {
    return binary
  }
  if (basename(resolved) !== "bd.js") return binary
  const native = join(dirname(resolved), process.platform === "win32" ? "bd.exe" : "bd")
  if (!existsSync(native)) throw new ServeHttpError("startup", "bd native executable unavailable")
  return native
}

async function waitUntil(deadline: number, settled: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      settled,
      new Promise<void>((done) => {
        timer = setTimeout(done, Math.max(0, deadline - Date.now()))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function validateTarget(target: WorkspaceTarget): void {
  if (
    target.mode !== "server" ||
    !target.localBeadsDir ||
    !existsSync(target.localBeadsDir) ||
    !existsSync(join(target.localBeadsDir, "metadata.json")) ||
    !target.serverConnection
  ) {
    throw new ServeHttpError("identity", "bd serve requires a prepared SQL workspace")
  }
}

async function waitForAddress(child: ChildProcess): Promise<string> {
  const stdout = child.stdout
  if (!stdout) throw new ServeHttpError("startup", "bd serve stdout unavailable")
  return new Promise((resolve, reject) => {
    let buffer = ""
    let settled = false
    const timer = setTimeout(
      () => fail(new ServeHttpError("startup", "bd serve startup timed out")),
      STARTUP_MS,
    )
    const cleanup = () => {
      clearTimeout(timer)
      stdout.off("data", onData)
      child.off("error", onError)
      child.off("exit", onExit)
    }
    const fail = (error: Error) => {
      if (!settled) {
        settled = true
        cleanup()
        reject(error)
      }
    }
    const onError = () => fail(new ServeHttpError("startup", "bd serve failed to start"))
    const onExit = () => fail(new ServeHttpError("startup", "bd serve exited before bind"))
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      if (buffer.length > 256)
        return fail(new ServeHttpError("startup", "Invalid bd serve startup line"))
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      const first = buffer.slice(0, newline).replace(/\r$/, "")
      const match = START_LINE.exec(first)
      if (!match || Number(match[2]) > 65535 || buffer.slice(newline + 1).trim()) {
        return fail(new ServeHttpError("startup", "Invalid bd serve startup line"))
      }
      settled = true
      cleanup()
      resolve(match[1])
    }
    stdout.on("data", onData)
    child.once("error", onError)
    child.once("exit", onExit)
  })
}

export class ServeManager {
  private readonly processes = new Map<string, OwnedProcess>()
  private readonly starts = new Map<string, Promise<OwnedProcess>>()
  private readonly stops = new Map<string, Promise<void>>()
  private readonly restartBackoff = new Map<string, { failures: number; retryAt: number }>()
  private closed = false
  private idleTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly stderrLogDirectory?: string) {}

  hasReadySession(target: WorkspaceTarget): boolean {
    const owned = this.processes.get(target.id)
    return !!(
      owned?.session &&
      owned.target.generation === target.generation &&
      !owned.draining &&
      owned.child.exitCode === null
    )
  }

  prewarm(target: WorkspaceTarget): void {
    void this.getSession(target).catch((error) => {
      const reason = error instanceof ServeHttpError ? error.kind : "unknown"
      const code = error instanceof ServeHttpError ? (error.code ?? "none") : "none"
      console.warn(`[bd-serve] prewarm failed workspace=${target.id} reason=${reason} code=${code}`)
    })
  }

  async getSession(target: WorkspaceTarget): Promise<ServeHttpSession> {
    return workspaceTransition.withOperation(target.id, async () => {
      await this.assertCurrentTarget(target)
      return this.getSessionWithinOperation(target)
    })
  }

  private async assertCurrentTarget(target: WorkspaceTarget): Promise<void> {
    const current = await resolveWorkspaceTarget(target.id)
    if (current.generation !== target.generation) {
      throw new ServeHttpError("identity", `Workspace target changed: ${target.id}`)
    }
  }

  private async getSessionWithinOperation(target: WorkspaceTarget): Promise<ServeHttpSession> {
    if (this.closed) throw new ServeHttpError("startup", "bd serve manager is shutting down")
    validateTarget(target)
    const stopping = this.stops.get(target.id)
    if (stopping) await stopping
    if (this.closed) throw new ServeHttpError("startup", "bd serve manager is shutting down")
    const startupKey = key(target)
    await this.stopStaleStarts(target, startupKey)
    const existing = this.processes.get(target.id)
    if (
      existing &&
      (existing.target.generation !== target.generation ||
        existing.draining ||
        existing.child.exitCode !== null)
    ) {
      await this.stop(target.id)
    }
    let owned = this.processes.get(target.id)
    if (!owned) {
      await this.waitForRestartBackoff(target.id)
      let pending = this.starts.get(startupKey)
      if (!pending) {
        pending = this.start(target)
        this.starts.set(startupKey, pending)
        void pending
          .finally(() => {
            this.starts.delete(startupKey)
          })
          .catch(() => {})
      }
      owned = await pending
    }
    if (!owned.session || owned.draining || owned.target.generation !== target.generation) {
      throw new ServeHttpError("identity", "bd serve session is no longer current")
    }
    owned.lastUsed = Date.now()
    return owned.session
  }

  private async stopStaleStarts(target: WorkspaceTarget, startupKey: string): Promise<void> {
    const staleStarts = [...this.starts.entries()]
      .filter(([otherKey]) => otherKey.startsWith(`${target.id}:`) && otherKey !== startupKey)
      .map(([, pending]) => pending)
    if (staleStarts.length) {
      await Promise.allSettled(staleStarts)
      await this.stop(target.id)
    }
  }

  private async waitForRestartBackoff(id: string): Promise<void> {
    const backoff = this.restartBackoff.get(id)
    if (backoff && backoff.retryAt > Date.now()) {
      await new Promise((done) => setTimeout(done, backoff.retryAt - Date.now()))
      if (this.closed) throw new ServeHttpError("startup", "bd serve manager is shutting down")
    }
  }

  private async start(target: WorkspaceTarget): Promise<OwnedProcess> {
    const binary = resolveServeBinary(resolveBdPath())
    if (!binary || (binary.includes("/") && !existsSync(binary)))
      throw new ServeHttpError("startup", "bd binary unavailable")
    const runtimeDir = await mkdtemp(join(tmpdir(), "beadbox-serve-"))
    const token = randomBytes(32).toString("base64url")
    const tokenFile = join(runtimeDir, "token")
    let child: ChildProcess | null = null
    let stderrLog: ServeStderrLog | null = null
    try {
      await chmod(runtimeDir, 0o700)
      await writeFile(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" })
      const connection = target.serverConnection!
      const credentialId = `${connection.host}:${connection.port}/${connection.database}/${connection.user}`
      const password = getWorkspacePassword(credentialId)
      const env = {
        ...process.env,
        ...buildServerEnv(connection, password),
        BEADS_DOLT_SERVER_MODE: "1",
        BEADS_DOLT_AUTO_START: "0",
      }
      const stderrLogEnabled = await bdServeStderrLogEnabled()
      child = spawn(
        binary,
        [
          "serve",
          "--db",
          join(target.localBeadsDir!, "dolt"),
          "--addr",
          "127.0.0.1:0",
          "--auth-token-file",
          tokenFile,
        ],
        {
          cwd: target.localBeadsDir!,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
      if (stderrLogEnabled) {
        try {
          stderrLog = new ServeStderrLog({
            workspaceId: target.id,
            connection,
            password,
            token,
            directory: this.stderrLogDirectory,
          })
          console.debug(`[bd-serve] stderr diagnostics enabled path=${stderrLog.path}`)
        } catch (error) {
          console.warn(
            `[bd-serve] stderr diagnostics unavailable workspace=${target.id} code=${diagnosticErrorCode(error)}`,
          )
        }
      }
      if (stderrLog) {
        const log = stderrLog
        let failed = false
        child.stderr?.on("data", (chunk: Buffer) => {
          if (failed) return
          try {
            log.write(chunk)
          } catch (error) {
            failed = true
            console.warn(
              `[bd-serve] stderr diagnostics write failed workspace=${target.id} code=${diagnosticErrorCode(error)}`,
            )
          }
        })
        const closeLog = () => {
          try {
            log.close()
          } catch {
            // Diagnostics must not affect the serve process.
          }
        }
        child.stderr?.once("end", closeLog)
        child.once("close", closeLog)
      } else {
        child.stderr?.resume()
      }
      const address = await waitForAddress(child)
      const owned: OwnedProcess = {
        target,
        child,
        runtimeDir,
        address,
        token,
        session: null,
        inFlight: 0,
        draining: false,
        lastUsed: Date.now(),
        waiters: [],
      }
      const handle: ServeHandle = {
        address,
        token,
        target,
        request: async <T>(path: string, init?: RequestInit): Promise<T> =>
          workspaceTransition.withOperation(target.id, async () => {
            await this.assertCurrentTarget(target)
            if (owned.draining || owned.child.exitCode !== null)
              throw new ServeHttpError("transport", "bd serve is stopping")
            owned.inFlight += 1
            owned.lastUsed = Date.now()
            try {
              return await requestServeJson<T>(address, token, path, init)
            } finally {
              owned.inFlight -= 1
              if (owned.inFlight === 0) {
                for (const done of owned.waiters.splice(0)) done()
              }
            }
          }),
      }
      owned.session = await ServeHttpSession.connect(handle)
      if (this.closed) throw new ServeHttpError("startup", "bd serve manager is shutting down")
      this.processes.set(target.id, owned)
      console.debug(`[bd-serve] ready workspace=${target.id} pid=${child.pid}`)
      child.once("exit", () => {
        if (this.processes.get(target.id) === owned) this.processes.delete(target.id)
        if (!owned.draining) this.noteFailure(target.id)
        owned.draining = true
        void rm(runtimeDir, { recursive: true, force: true })
      })
      this.ensureIdleTimer()
      void this.evictIfNeeded(target.id)
      return owned
    } catch (error) {
      this.noteFailure(target.id)
      child?.kill("SIGTERM")
      await rm(runtimeDir, { recursive: true, force: true })
      throw error
    }
  }

  private noteFailure(id: string): void {
    const failures = Math.min((this.restartBackoff.get(id)?.failures ?? 0) + 1, 6)
    this.restartBackoff.set(id, {
      failures,
      retryAt: Date.now() + Math.min(250 * 2 ** (failures - 1), 8_000),
    })
  }

  private ensureIdleTimer(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      for (const [id, owned] of this.processes) {
        if (Date.now() - owned.lastUsed >= IDLE_MS && owned.inFlight === 0) void this.stop(id)
      }
    }, 60_000)
    this.idleTimer.unref?.()
  }

  private async evictIfNeeded(exemptId: string): Promise<void> {
    if (this.processes.size <= MAX_SERVERS) return
    const candidate = [...this.processes.values()]
      .filter((p) => p.target.id !== exemptId && !p.draining)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (candidate) await this.stop(candidate.target.id)
  }

  async stop(id: string): Promise<void> {
    const stopping = this.stops.get(id)
    if (stopping) return stopping
    const owned = this.processes.get(id)
    if (!owned) {
      const pending = [...this.starts.entries()].find(([startupKey]) =>
        startupKey.startsWith(`${id}:`),
      )?.[1]
      if (pending)
        await pending.then(
          () => this.stop(id),
          () => {},
        )
      return
    }
    const task = this.stopOwned(id, owned)
    this.stops.set(id, task)
    try {
      await task
    } finally {
      this.stops.delete(id)
    }
  }

  private async stopOwned(id: string, owned: OwnedProcess): Promise<void> {
    const deadline = Date.now() + DRAIN_MS
    const closed =
      owned.child.exitCode === null
        ? new Promise<void>((done) => owned.child.once("close", () => done()))
        : null
    owned.draining = true
    this.processes.delete(id)
    if (owned.inFlight) {
      await waitUntil(deadline, new Promise<void>((done) => owned.waiters.push(done)))
    }
    if (owned.child.exitCode === null) {
      const exited = new Promise<void>((done) => owned.child.once("exit", () => done()))
      owned.child.kill("SIGTERM")
      await waitUntil(deadline, exited)
      if (owned.child.exitCode === null) owned.child.kill("SIGKILL")
    }
    if (closed) await waitUntil(deadline, closed)
    await rm(owned.runtimeDir, { recursive: true, force: true })
  }

  async stopAll(): Promise<void> {
    this.closed = true
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    await Promise.allSettled([...this.starts.values()])
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id)))
    await Promise.allSettled([...this.stops.values()])
  }
}

export const serveManager = new ServeManager()
