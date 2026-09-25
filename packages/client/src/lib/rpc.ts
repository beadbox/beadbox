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
import { hydrateSavedPasswords } from "./tauri-credentials"

/**
 * Type of the remote API exposed by the sidecar's kkrpc handler registry.
 * The `typeof handlers` is the source of truth — if a handler signature
 * drifts in packages/server, this client's typecheck fails.
 */
export type RemoteApi = typeof serverHandlers

const SIDECAR_NAME = "beadbox-sidecar"

/**
 * The sidecar did not answer within the client deadline. The process may be
 * alive but not reading its stdin, so the manager restarts it (beadbox-x3y).
 */
export class RpcDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`The Beadbox sidecar did not respond within ${Math.round(deadlineMs / 1000)}s and is being restarted`)
    this.name = "RpcDeadlineError"
  }
}

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

interface SidecarManagerOptions {
  /** Unexpected exits allowed inside `windowMs` before auto-reconnect stops. */
  maxAutoReconnects?: number
  windowMs?: number
  now?: () => number
  /**
   * Runs on every new sidecar session, before the API is handed to callers
   * (beadbox-ct1: restore saved server passwords, which a fresh sidecar
   * process does not have). Bounded by onConnectTimeoutMs; a failure or a
   * timeout is logged and the session is used anyway.
   */
  onConnect?: (api: RemoteApi) => Promise<void>
  onConnectTimeoutMs?: number
  /**
   * How long `call` waits for a reply. Must exceed the sidecar's own 30s
   * handler race, so a slow bd call is reported by the sidecar instead of
   * getting a healthy process restarted.
   */
  callDeadlineMs?: number
  /** Consecutive deadline misses that trigger a restart. */
  maxConsecutiveMisses?: number
}

// Keep the exit listener alive across reconnects. Destroying kkrpc rejects
// pending requests, so a sidecar crash cannot leave the loading spinner
// waiting forever for a reply that will never arrive.
//
// `onExitUnexpected` tells subscribers to re-attach (it respawns the sidecar
// via their next call). A sidecar that dies at boot would turn that into an
// endless respawn loop, so past the budget an exit still tears the session
// down but does not ask anyone to reconnect; the next explicit call (Retry,
// a user action) respawns. The budget is a sliding window of exit times and
// is deliberately NOT reset by a successful connect: connecting does not
// prove the process survives boot.
//
// When a session connects after a suppressed exit, subscribers are still
// holding the dead sidecar's subscription id, and the new sidecar's events
// would be filtered out as foreign. Notify them on that connect so they
// re-subscribe; otherwise live updates stay silently dead after recovery.
export function createSidecarManager(
  runtime: SidecarRuntime,
  onExitUnexpected?: () => void,
  options: SidecarManagerOptions = {},
) {
  const {
    maxAutoReconnects = 3,
    windowMs = 60_000,
    now = Date.now,
    onConnect,
    onConnectTimeoutMs = 5_000,
    callDeadlineMs = 45_000,
    maxConsecutiveMisses = 1,
  } = options
  let channelPromise: Promise<RemoteApi> | null = null
  let session: SidecarSession | null = null
  let listenerPromise: Promise<unknown> | null = null
  let generation = 0
  let recentExits: number[] = []
  let resubscribeOnConnect = false
  let consecutiveMisses = 0
  // A restart's kill must finish before the next spawn: the plugin refuses a
  // second process under a name that is still registered.
  let pendingKill: Promise<unknown> | null = null

  // Counts an exit or a restart against the respawn budget and says whether
  // subscribers may be told to re-attach right away.
  function recordLoss(): boolean {
    const at = now()
    recentExits = recentExits.filter((t) => at - t < windowMs)
    recentExits.push(at)
    const withinBudget = recentExits.length <= maxAutoReconnects
    if (!withinBudget) resubscribeOnConnect = true
    return withinBudget
  }

  function ensureExitListener(): Promise<unknown> {
    listenerPromise ??= runtime
      .onExit(() => {
        generation++
        consecutiveMisses = 0
        const oldSession = session
        session = null
        channelPromise = null
        const withinBudget = recordLoss()
        try {
          oldSession?.destroy()
        } finally {
          if (withinBudget) onExitUnexpected?.()
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
      if (pendingKill) await pendingKill
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
      if (onConnect) await runOnConnect(onConnect, nextSession.api, onConnectTimeoutMs)
      if (resubscribeOnConnect) {
        resubscribeOnConnect = false
        onExitUnexpected?.()
      }
      return nextSession.api
    })().catch((error: unknown) => {
      if (channelPromise === initializing) channelPromise = null
      throw error
    })
    channelPromise = initializing
    return initializing
  }

  // A sidecar that is alive but not reading stdin never exits, so the exit
  // listener above never fires, and killing it through the plugin emits no
  // exit event either (kill removes the process entry first). A restart
  // therefore does the exit listener's whole job itself: new generation, the
  // old session destroyed so its pending calls reject, the loss counted
  // against the budget, and subscribers told to re-attach. Without that last
  // step the subscription keeps the dead sidecar's id and live updates stop
  // silently (beadbox-x3y).
  function restart(expectedGeneration: number = generation): void {
    if (generation !== expectedGeneration) return // already restarted or exited
    generation++
    consecutiveMisses = 0
    const oldSession = session
    session = null
    channelPromise = null
    const withinBudget = recordLoss()
    const killing = runtime
      .kill()
      .catch(() => {}) // the process may already be gone
      .finally(() => {
        if (pendingKill === killing) pendingKill = null
      })
    pendingKill = killing
    try {
      oldSession?.destroy()
    } finally {
      if (withinBudget) onExitUnexpected?.()
    }
  }

  // Run one call against the sidecar with a deadline covering the connect as
  // well, since a wedged process can also hang the channel handshake.
  async function call<T>(invoke: (api: RemoteApi) => Promise<T>): Promise<T> {
    const callGeneration = generation
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RpcDeadlineError(callDeadlineMs)), callDeadlineMs)
    })
    try {
      const result = await Promise.race([getRemoteApi().then(invoke), deadline])
      if (generation === callGeneration) consecutiveMisses = 0
      return result
    } catch (error) {
      // A miss counts only against the sidecar the call was sent to; a late
      // miss from before a restart must not restart the new one.
      if (error instanceof RpcDeadlineError && generation === callGeneration) {
        consecutiveMisses++
        if (consecutiveMisses >= maxConsecutiveMisses) restart(callGeneration)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  return { getRemoteApi, call, restart }
}

// A keychain read can raise an OS prompt that nobody answers, so the hook is
// raced against a timeout. On timeout or failure the session is still used:
// the startup health check then reports access_denied and the re-auth prompt
// appears, which is exactly what happened before the hook existed.
async function runOnConnect(
  onConnect: (api: RemoteApi) => Promise<void>,
  api: RemoteApi,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  try {
    const outcome = await Promise.race([onConnect(api).then(() => "done" as const), timeout])
    if (outcome === "timeout")
      console.warn(`[rpc] sidecar onConnect timed out after ${timeoutMs}ms`)
  } catch (err) {
    console.warn("[rpc] sidecar onConnect failed:", err)
  } finally {
    clearTimeout(timer)
  }
}

// Restore saved server passwords on every new sidecar (beadbox-ct1).
export const SIDECAR_MANAGER_OPTIONS: SidecarManagerOptions = { onConnect: hydrateSavedPasswords }

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
  // Also fired when a session connects after a suppressed exit: either way it
  // means "the sidecar you subscribed to is gone; subscribe again".
  () => window.dispatchEvent(new Event("beadbox:sidecar-exit")),
  SIDECAR_MANAGER_OPTIONS,
)


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
            try {
              const result = await sidecarManager.call((api) => {
                const namespace = (
                  api as unknown as Record<
                    string,
                    Record<string, (...a: unknown[]) => Promise<unknown>>
                  >
                )[ns]
                if (!namespace) throw new RpcUnavailableError(`${ns} (unknown namespace)`)
                const fn = namespace[prop]
                if (typeof fn !== "function") throw new RpcUnavailableError(`${ns}.${prop}`)
                return fn(...args)
              })
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
