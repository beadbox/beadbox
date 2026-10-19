// The Node side of the headless test transport (beadbox-r72.3, systemdesign §7.2).
//
// One real sidecar per Playwright worker, spawned with stdio pipes. A page
// reaches it through window.__beadboxTestBridge, which attach() installs with
// addInitScript + exposeBinding: a CDP binding, not a socket, so the harness
// opens no listener of its own (§3.4). The page side, packages/client/src/
// lib/test-transport.ts, rebuilds whole lines from whatever chunks arrive, so
// this side relays raw pipe chunks.
//
// Kills: only the pid this bridge spawned, and that pid's own descendants,
// with SIGKILL (a SIGTERM makes the sidecar dump state that includes its env).

import { type ChildProcess, spawn, spawnSync } from "child_process"
import { isAbsolute, join } from "path"
import type { Page } from "@playwright/test"

/** Mirrors StreamData in packages/client/src/lib/test-transport.ts: `{ eof: true }` ends the current child's stream. */
type StreamData = string | { eof: true } | null
type Waiter = { page: Page; resolve: (data: StreamData) => void }

/** One stream (stdout or stderr), delivered to whichever page is attached. */
class Stream {
  private queue: Exclude<StreamData, null>[] = []
  private waiter: Waiter | null = null
  private page: Page | null = null

  /** A new page starts clean: replies meant for an earlier page are dropped, as after a reload. */
  attach(page: Page): void {
    this.page = page
    this.queue = []
    this.waiter?.resolve(null)
    this.waiter = null
  }

  detach(page: Page): void {
    if (this.page !== page) return
    this.page = null
    this.waiter = null
    this.queue = []
  }

  push(data: Exclude<StreamData, null>): void {
    if (!this.page) return
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      waiter.resolve(data)
    } else this.queue.push(data)
  }

  /** null tells the page the bridge is gone (its IO then parks). */
  read(page: Page): Promise<StreamData> {
    if (page !== this.page) return Promise.resolve(null)
    const next = this.queue.shift()
    if (next !== undefined) return Promise.resolve(next)
    return new Promise((resolve) => {
      this.waiter = { page, resolve }
    })
  }
}

export interface SidecarBridgeOptions {
  repoRoot: string
  /** Extra environment for the sidecar: registries, log path, HOME, BD_PATH. */
  env: NodeJS.ProcessEnv
  /** How long to wait for the sidecar's start line before failing. */
  startTimeoutMs?: number
}

/** BEADBOX_SIDECAR picks the binary: the compiled beadbox-sidecar on CI, the TypeScript entry locally. */
export function sidecarCommand(repoRoot: string, env = process.env): string[] {
  const chosen = env.BEADBOX_SIDECAR
  if (!chosen) return ["bun", join(repoRoot, "packages", "server", "src", "index.ts")]
  return [isAbsolute(chosen) ? chosen : join(repoRoot, chosen)]
}

/** pid's descendants, deepest first. */
function descendantsOf(pid: number): number[] {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf-8" })
  const children = new Map<number, number[]>()
  for (const line of ps.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (!child || !parent) continue
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const out: number[] = []
  const walk = (p: number) => {
    for (const c of children.get(p) ?? []) {
      walk(c)
      out.push(c)
    }
  }
  walk(pid)
  return out
}

export class SidecarBridge {
  private child: ChildProcess | null = null
  private exitCode: number | null | undefined = undefined
  private exitWaiters: ((code: number | null) => void)[] = []
  private readonly stdout = new Stream()
  private readonly stderr = new Stream()
  private stderrTail = ""
  readonly command: string[]

  constructor(private readonly options: SidecarBridgeOptions) {
    this.command = sidecarCommand(options.repoRoot, { ...process.env, ...options.env })
  }

  get pid(): number | undefined {
    return this.exitCode === undefined ? this.child?.pid : undefined
  }

  /**
   * Start the sidecar and wait for its start line. Every way it fails to come
   * up throws with the cause first: the binary missing, an exit before the
   * start line (with its code and stderr tail), or no start line in time.
   */
  async spawn(): Promise<number> {
    if (this.pid !== undefined) return this.pid
    const [file, ...args] = this.command
    const child = spawn(file, args, {
      cwd: this.options.repoRoot,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child
    this.exitCode = undefined
    this.stderrTail = ""
    child.stdout?.on("data", (chunk: Buffer) => this.stdout.push(chunk.toString("utf8")))
    // The end of each stream, in order with its data: the page flushes a last line that has no newline.
    child.stdout?.on("end", () => this.stdout.push({ eof: true }))
    child.stderr?.on("end", () => this.stderr.push({ eof: true }))
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      this.stderrTail = (this.stderrTail + text).slice(-2_000)
      this.stderr.push(text)
    })
    child.on("exit", (code) => {
      this.exitCode = code
      for (const waiter of this.exitWaiters.splice(0)) waiter(code)
    })

    const timeoutMs = this.options.startTimeoutMs ?? 30_000
    await new Promise<void>((resolve, reject) => {
      const fail = (cause: string) => {
        clearTimeout(timer)
        clearInterval(poll)
        reject(new Error(`[sidecar-bridge] the sidecar did not start: ${cause} (command: ${this.command.join(" ")})`))
      }
      child.once("error", (error: NodeJS.ErrnoException) =>
        fail(error.code === "ENOENT" ? `${file} not found` : error.message),
      )
      child.once("exit", (code, signal) =>
        fail(`it exited (${signal ?? `code ${code}`}) before starting. stderr: ${this.stderrTail.trim().slice(-500)}`),
      )
      const timer = setTimeout(() => fail(`no start line within ${timeoutMs} ms. stderr: ${this.stderrTail.trim().slice(-500)}`), timeoutMs)
      const poll = setInterval(() => {
        if (/\[beadbox-sidecar\] starting pid=/.test(this.stderrTail)) {
          clearTimeout(timer)
          clearInterval(poll)
          child.removeAllListeners("error")
          child.removeAllListeners("exit")
          child.on("exit", (code) => {
            this.exitCode = code
            for (const waiter of this.exitWaiters.splice(0)) waiter(code)
          })
          resolve()
        }
      }, 20)
    })
    return child.pid as number
  }

  /** SIGKILL the sidecar this bridge spawned and its descendants. Returns the pids killed. */
  kill(): number[] {
    const pid = this.pid
    if (pid === undefined) return []
    const pids = [...descendantsOf(pid), pid]
    for (const p of pids) {
      try {
        process.kill(p, "SIGKILL")
      } catch {
        // Already gone.
      }
    }
    return pids
  }

  status(): { running: boolean; pid?: number } {
    return { running: this.pid !== undefined, pid: this.pid }
  }

  write(data: string): boolean {
    if (!this.child?.stdin || this.pid === undefined) return false
    this.child.stdin.write(data)
    return true
  }

  waitExit(): Promise<number | null> {
    if (this.exitCode !== undefined) return Promise.resolve(this.exitCode)
    return new Promise((resolve) => this.exitWaiters.push(resolve))
  }

  /** Install window.__beadboxTestBridge on a page. Call before the first navigation. */
  async attach(page: Page): Promise<void> {
    this.stdout.attach(page)
    this.stderr.attach(page)
    page.once("close", () => {
      this.stdout.detach(page)
      this.stderr.detach(page)
    })
    await page.exposeBinding("__beadboxBridgeCall", async ({ page: from }, op: string, data?: string) => {
      switch (op) {
        case "spawn":
          return this.spawn()
        case "kill":
          return this.kill().length > 0
        case "status":
          return this.status()
        case "write":
          return this.write(data ?? "")
        case "read":
          return this.stdout.read(from)
        case "readStderr":
          return this.stderr.read(from)
        case "waitExit":
          return this.waitExit()
        default:
          throw new Error(`[sidecar-bridge] unknown op ${op}`)
      }
    })
    await page.addInitScript(() => {
      type Call = (op: string, data?: string) => Promise<unknown>
      const call = (window as unknown as { __beadboxBridgeCall: Call }).__beadboxBridgeCall
      ;(window as unknown as Record<string, unknown>).__beadboxTestBridge = {
        spawn: () => call("spawn"),
        kill: () => call("kill"),
        status: () => call("status"),
        write: (data: string) => call("write", data),
        read: () => call("read"),
        readStderr: () => call("readStderr"),
        waitExit: () => call("waitExit"),
      }
    })
  }
}
