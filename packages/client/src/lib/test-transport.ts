// Test-only sidecar transport (beadbox-r72.2, systemdesign §7.2, ADR-002).
//
// Headless Playwright runs the real bundle against the real sidecar: the
// Playwright worker spawns the sidecar with stdio pipes and installs
// window.__beadboxTestBridge (addInitScript + exposeBinding, a CDP binding,
// not a socket). This module is the page side of that bridge: the twin of
// tauri-plugin-js-api's JsRuntimeIo, onExit and onStderr.
//
// It is reached ONLY through the dynamic import() in sidecar-transport.ts,
// inside the branch that a release build compiles out; the build guard
// (vite-plugins/test-transport-guard.ts) fails any release build that contains this
// module's marker, __beadboxTestBridge.

import type { UnlistenFn } from "@tauri-apps/api/event"
import type { IoInterface, IoMessage } from "kkrpc/browser"
import type { RemoteApi, SidecarRuntime, SidecarSession } from "./rpc"

/** What the Playwright worker installs on window. Every call is one CDP round-trip. */
export interface TestBridge {
  spawn(): Promise<unknown>
  kill(): Promise<unknown>
  status(): Promise<{ running: boolean }>
  /** Write a kkrpc frame to the sidecar's stdin. */
  write(data: string): Promise<unknown>
  /** The next stdout data, in any chunking; END when the child's stdout ends; null only when the bridge is closing. */
  read(): Promise<StreamData>
  /** The next stderr data, in any chunking; END when the child's stderr ends; null only when the bridge is closing. */
  readStderr(): Promise<StreamData>
  /** Resolves with the exit code of the running sidecar when it exits. */
  waitExit(): Promise<number | null>
}

/**
 * What a bridge read returns. `{ eof: true }` marks the end of the current
 * child's stream, in order with its data, so the last line is flushed even
 * without a trailing newline (Rust's BufReader::lines() yields it at EOF);
 * the stream continues with the next child after a respawn.
 */
export type StreamData = string | { eof: true } | null

type GetBridge = () => TestBridge

function windowBridge(): TestBridge {
  const bridge = (window as unknown as { __beadboxTestBridge?: TestBridge }).__beadboxTestBridge
  if (!bridge) throw new Error("test transport: window.__beadboxTestBridge is not installed")
  return bridge
}

const never = <T>(): Promise<T> => new Promise<T>(() => {})

/**
 * Splits a byte stream back into the lines production delivers: Rust's
 * BufReader::lines() hands tauri-plugin-js one event per line, so neither
 * kkrpc nor the stderr consumers ever see a partial line. A pipe relay can
 * cut anywhere, and kkrpc drops a read that is only "\n" (gluing two frames
 * so neither call resolves), so the lines are rebuilt here. Linear in the
 * input: only each new chunk is scanned.
 */
class LineSplitter {
  private partial: string[] = []

  /** The complete lines in `chunk`, without their "\n". */
  push(chunk: string): string[] {
    const lines: string[] = []
    let start = 0
    for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
      this.partial.push(chunk.slice(start, end))
      lines.push(this.partial.join(""))
      this.partial = []
      start = end + 1
    }
    if (start < chunk.length) this.partial.push(chunk.slice(start))
    return lines
  }

  /** At the end of a stream: the unterminated last line, if any. */
  flush(): string[] {
    const last = this.partial.join("")
    this.partial = []
    return last ? [last] : []
  }
}

function linesOf(splitter: LineSplitter, data: string | { eof: true }): string[] {
  return typeof data === "string" ? splitter.push(data) : splitter.flush()
}

/** kkrpc IO over the bridge: the JsRuntimeIo twin. */
export class BindingIo implements IoInterface {
  readonly name = "beadbox-test-transport"
  private destroyed = false
  private readonly listeners = new Set<(message: string | IoMessage) => void>()
  private readonly splitter = new LineSplitter()
  private readonly lines: string[] = []

  constructor(private readonly getBridge: GetBridge = windowBridge) {}

  get isDestroyed(): boolean {
    return this.destroyed
  }

  /** The next whole frame with its "\n", as JsRuntimeIo returns it. */
  async read(): Promise<string | null> {
    // Never resolves after destroy, so kkrpc's listen loop parks, as JsRuntimeIo's does.
    if (this.destroyed) return never()
    while (this.lines.length === 0) {
      const data = await this.getBridge().read()
      if (this.destroyed || data == null) return never()
      this.lines.push(...linesOf(this.splitter, data))
    }
    const line = `${this.lines.shift()}\n`
    for (const listener of this.listeners) listener(line)
    return line
  }

  async write(message: string | IoMessage): Promise<void> {
    // The sidecar's stdin carries text frames only, as JsRuntimeIo's does.
    if (typeof message !== "string")
      throw new Error("test transport: only text frames can be written")
    await this.getBridge().write(message)
  }

  on(event: "message", listener: (message: string | IoMessage) => void): void
  on(event: "error", listener: (error: Error) => void): void
  on(
    event: "message" | "error",
    listener: ((message: string | IoMessage) => void) | ((error: Error) => void),
  ): void {
    if (event === "message") this.listeners.add(listener as (message: string | IoMessage) => void)
  }

  off(event: "message" | "error", listener: (...args: never[]) => void): void {
    if (event === "message")
      this.listeners.delete(listener as (message: string | IoMessage) => void)
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.listeners.clear()
  }
}

export interface TestTransport {
  runtime: SidecarRuntime
  onStderr: (name: string, callback: (data: string) => void) => Promise<UnlistenFn>
}

export function createTestTransport(getBridge: GetBridge = windowBridge): TestTransport {
  const exitListeners = new Set<(code: number | null) => void>()
  let watchingExit = false
  // Watch for an exit only while a sidecar is known to be running, so a
  // bridge with no child can never spin this loop.
  function watchExit(): void {
    if (watchingExit) return
    watchingExit = true
    void getBridge()
      .waitExit()
      .then((code) => {
        watchingExit = false
        for (const listener of [...exitListeners]) listener(code)
      })
  }

  const stderrListeners = new Set<(data: string) => void>()
  let pumpingStderr = false
  async function pumpStderr(): Promise<void> {
    const splitter = new LineSplitter()
    for (;;) {
      const data = await getBridge().readStderr()
      if (data == null) break
      for (const line of linesOf(splitter, data)) {
        for (const listener of [...stderrListeners]) listener(line)
      }
    }
    pumpingStderr = false
  }

  const runtime: SidecarRuntime = {
    onExit: async (callback) => {
      exitListeners.add(callback)
      return () => exitListeners.delete(callback)
    },
    spawn: async () => {
      const result = await getBridge().spawn()
      watchExit()
      return result
    },
    kill: () => getBridge().kill(),
    isRunning: async () => {
      const running = (await getBridge().status()).running === true
      if (running) watchExit()
      return running
    },
    connect: async (): Promise<SidecarSession> => {
      const { RPCChannel } = await import("kkrpc/browser")
      const io = new BindingIo(getBridge)
      const channel = new RPCChannel<Record<string, never>, RemoteApi>(io, { expose: {} })
      return {
        api: channel.getAPI() as RemoteApi,
        destroy: () => {
          try {
            void Promise.resolve(channel.destroy()).catch(() => {})
          } finally {
            void io.destroy().catch(() => {})
          }
        },
      }
    },
  }

  const onStderr = async (_name: string, callback: (data: string) => void): Promise<UnlistenFn> => {
    stderrListeners.add(callback)
    if (!pumpingStderr) {
      pumpingStderr = true
      void pumpStderr()
    }
    return () => {
      stderrListeners.delete(callback)
    }
  }

  return { runtime, onStderr }
}

const defaultTransport = createTestTransport()
export const runtime = defaultTransport.runtime
export const onStderr = defaultTransport.onStderr
