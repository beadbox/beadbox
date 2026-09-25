// Typed kkrpc client wrapper.
//
// Two runtime modes:
//   1) Tauri shell — spawn the compiled Bun sidecar via tauri-plugin-js,
//      then createChannel<{}, HandlerRegistry> for typed dispatch over
//      stdio. The sidecar's stdout is the kkrpc wire; its stderr carries
//      the structured [SUBSCRIPTION:<id>] event stream consumed by
//      ./subscribe.ts via onStderr.
//   2) Browser-only (vite dev with no Tauri shell) — every namespace
//      method throws a sentinel `RpcUnavailableError`. Callers wrap in
//      TanStack Query so the error surface is uniform; routes can
//      detect this via `isTauriRuntime()` and short-circuit when needed.
//
// Pattern lifted from TB0.4 (commit 0af0aca / d1cb02a) — proven dual-
// channel reference. The lazy singleton means we spawn the sidecar at
// most once per browser session; concurrent first-callers share the
// same in-flight promise.

import type { handlers as serverHandlers } from "@beadbox/server/handlers"
import { createChannel, kill, onExit, spawn } from "tauri-plugin-js-api"
import type { BdCommandEvent } from "./console-types"

/**
 * Type of the remote API exposed by the sidecar's kkrpc handler registry.
 * The `typeof handlers` is the source of truth — if a handler signature
 * drifts in packages/server, this client's typecheck fails.
 */
export type RemoteApi = typeof serverHandlers

const SIDECAR_NAME = "beadbox-sidecar"

export class RpcUnavailableError extends Error {
  constructor(method: string) {
    super(`rpc.${method} is not available outside the Tauri shell`)
    this.name = "RpcUnavailableError"
  }
}

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false
  return (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null
}

// bb-ck7j: dev-console rpc tap. Set by home-page/activity-page when the
// dev console mounts; called from the Proxy on every rpc.* invocation so
// the Commands tab populates as the app fires bd commands. Null when no
// dev console is mounted (production users without the panel open) — the
// emit becomes a no-op.
let _rpcTap: ((evt: BdCommandEvent) => void) | null = null

export function setRpcTap(cb: ((evt: BdCommandEvent) => void) | null): void {
  _rpcTap = cb
}

// bb-jjdw: test-only seam — read the current rpc tap so unit tests can
// verify a hook's wiring without mock.module (which replaces the module
// wholesale and corrupts every other consumer's import).
export function _getRpcTap(): ((evt: BdCommandEvent) => void) | null {
  return _rpcTap
}

function summarizeArg(arg: unknown): string {
  if (arg === null) return "null"
  if (arg === undefined) return "undefined"
  if (typeof arg === "string") return arg.length > 40 ? `${arg.slice(0, 37)}...` : arg
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg)
  try {
    const json = JSON.stringify(arg)
    return json.length > 60 ? `${json.slice(0, 57)}...` : json
  } catch {
    return "[unserializable]"
  }
}

function summarizeResult(result: unknown): string | null {
  if (result === undefined || result === null) return null
  if (Array.isArray(result)) return `array(${result.length})`
  if (typeof result === "object") {
    const keys = Object.keys(result as object)
    return `object(${keys.length}k)`
  }
  if (typeof result === "string") return result.length > 60 ? `${result.slice(0, 57)}...` : result
  return String(result)
}

interface SidecarSession {
  api: RemoteApi
  destroy: () => void
}

interface SidecarRuntime {
  onExit: (callback: (code: number | null) => void) => Promise<unknown>
  spawn: () => Promise<unknown>
  kill: () => Promise<unknown>
  connect: () => Promise<SidecarSession>
}

// Keep the exit listener alive across reconnects. Destroying kkrpc rejects
// pending requests, so a sidecar crash cannot leave the loading spinner
// waiting forever for a reply that will never arrive.
export function createSidecarManager(runtime: SidecarRuntime, onExitUnexpected?: () => void) {
  let channelPromise: Promise<RemoteApi> | null = null
  let session: SidecarSession | null = null
  let listenerPromise: Promise<unknown> | null = null
  let generation = 0

  function ensureExitListener(): Promise<unknown> {
    listenerPromise ??= runtime
      .onExit(() => {
        generation++
        const oldSession = session
        session = null
        channelPromise = null
        try {
          oldSession?.destroy()
        } finally {
          onExitUnexpected?.()
        }
      })
      .catch((error: unknown) => {
        listenerPromise = null
        throw error
      })
    return listenerPromise
  }

  function getRemoteApi(): Promise<RemoteApi> {
    if (channelPromise) return channelPromise
    const expectedGeneration = generation
    let initializing: Promise<RemoteApi>
    initializing = (async () => {
      await ensureExitListener()
      if (generation !== expectedGeneration) throw new Error("Sidecar exited during startup")
      await runtime.spawn()
      if (generation !== expectedGeneration) throw new Error("Sidecar exited during startup")
      let nextSession: SidecarSession
      try {
        nextSession = await runtime.connect()
      } catch (error) {
        // A failed channel handshake can leave a live process registered by
        // tauri-plugin-js; remove it so the next attempt may spawn again.
        if (generation === expectedGeneration) await runtime.kill().catch(() => {})
        throw error
      }
      if (generation !== expectedGeneration) {
        nextSession.destroy()
        throw new Error("Sidecar exited during startup")
      }
      session = nextSession
      return nextSession.api
    })().catch((error: unknown) => {
      if (channelPromise === initializing) channelPromise = null
      throw error
    })
    channelPromise = initializing
    return initializing
  }

  return { getRemoteApi }
}

const sidecarManager = createSidecarManager(
  {
    onExit: (callback) => onExit(SIDECAR_NAME, callback),
    spawn: () => spawn(SIDECAR_NAME, { sidecar: SIDECAR_NAME }),
    kill: () => kill(SIDECAR_NAME),
    connect: async () => {
      const { api, channel, io } = await createChannel<Record<string, never>, RemoteApi>(
        SIDECAR_NAME,
      )
      return {
        api,
        destroy: () => {
          try {
            void Promise.resolve(channel.destroy()).catch(() => {})
          } finally {
            void io.destroy().catch(() => {})
          }
        },
      }
    },
  },
  () => window.dispatchEvent(new Event("beadbox:sidecar-exit")),
)

const getRemoteApi = sidecarManager.getRemoteApi

/**
 * Build a Proxy that routes `rpc.<namespace>.<method>(...args)` to the
 * lazy-resolved kkrpc remote API. The Proxy is what gives us namespace.method
 * access without listing every handler statically — adding a new handler
 * server-side appears here automatically (typecheck included).
 */
function buildTauriRpc(): RemoteApi {
  const namespaceProxy = (ns: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop: string) {
          return async (...args: unknown[]): Promise<unknown> => {
            const startMs = Date.now()
            const api = await getRemoteApi()
            const namespace = (
              api as unknown as Record<
                string,
                Record<string, (...a: unknown[]) => Promise<unknown>>
              >
            )[ns]
            if (!namespace) throw new RpcUnavailableError(`${ns} (unknown namespace)`)
            const fn = namespace[prop]
            if (typeof fn !== "function") throw new RpcUnavailableError(`${ns}.${prop}`)
            try {
              const result = await fn(...args)
              // bb-ck7j: emit Commands-tab entry with source="app". Skip the
              // "console" namespace — handleExecuteCommand emits richer
              // entries (with stdout + source="console") for typed commands.
              if (_rpcTap && ns !== "console") {
                _rpcTap({
                  type: "bd_command",
                  id: crypto.randomUUID(),
                  timestamp: Date.now(),
                  command: ns,
                  args: [prop, ...args.map(summarizeArg)],
                  dbPath: null,
                  durationMs: Date.now() - startMs,
                  exitCode: 0,
                  resultSummary: summarizeResult(result),
                  stderr: null,
                  stdout: null,
                  source: "app",
                })
              }
              return result
            } catch (err) {
              if (_rpcTap && ns !== "console") {
                _rpcTap({
                  type: "bd_command",
                  id: crypto.randomUUID(),
                  timestamp: Date.now(),
                  command: ns,
                  args: [prop, ...args.map(summarizeArg)],
                  dbPath: null,
                  durationMs: Date.now() - startMs,
                  exitCode: 1,
                  resultSummary: null,
                  stderr: err instanceof Error ? err.message : String(err),
                  stdout: null,
                  source: "app",
                })
              }
              throw err
            }
          }
        },
      },
    )

  // List the namespaces we know about. Adding a new server namespace requires
  // adding it here too — the `satisfies RemoteApi` check below catches drift.
  const tauri = {
    activity: namespaceProxy("activity"),
    beads: namespaceProxy("beads"),
    console: namespaceProxy("console"),
    diagnostics: namespaceProxy("diagnostics"),
    epics: namespaceProxy("epics"),
    formulas: namespaceProxy("formulas"),
    health: namespaceProxy("health"),
    molecules: namespaceProxy("molecules"),
    recovery: namespaceProxy("recovery"),
    subscribe: namespaceProxy("subscribe"),
    system: namespaceProxy("system"),
    trains: namespaceProxy("trains"),
    workspaces: namespaceProxy("workspaces"),
  } satisfies Record<keyof RemoteApi, unknown>

  return tauri as unknown as RemoteApi
}

function buildStubRpc(): RemoteApi {
  const namespaceStub = (ns: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop: string) {
          return async (): Promise<never> => {
            throw new RpcUnavailableError(`${ns}.${prop}`)
          }
        },
      },
    )

  return {
    activity: namespaceStub("activity"),
    beads: namespaceStub("beads"),
    console: namespaceStub("console"),
    diagnostics: namespaceStub("diagnostics"),
    epics: namespaceStub("epics"),
    formulas: namespaceStub("formulas"),
    health: namespaceStub("health"),
    molecules: namespaceStub("molecules"),
    recovery: namespaceStub("recovery"),
    subscribe: namespaceStub("subscribe"),
    system: namespaceStub("system"),
    trains: namespaceStub("trains"),
    workspaces: namespaceStub("workspaces"),
  } as unknown as RemoteApi
}

let _rpc: RemoteApi = isTauriRuntime() ? buildTauriRpc() : buildStubRpc()

/**
 * Test-only override. Lets unit tests inject a mocked RemoteApi without
 * needing module-level mocking primitives (bun:test has limited surface
 * compared to vitest's `vi.mock`).
 */
export function _setRpc(mock: RemoteApi): void {
  _rpc = mock
}

/** Test-only reset. */
export function _resetRpc(): void {
  _rpc = isTauriRuntime() ? buildTauriRpc() : buildStubRpc()
}

export const rpc: RemoteApi = new Proxy({} as RemoteApi, {
  get(_target, prop: string) {
    return (_rpc as unknown as Record<string, unknown>)[prop]
  },
})
