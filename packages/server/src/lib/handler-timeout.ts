// Handler-level timeout race for kkrpc handlers (bb-3pqz).
//
// Why this exists: mysql2 has no per-query timeout by default. dolt-pool's
// connectTimeout only governs TCP-connect; once a connection is open, an
// awaited pool.query() can hang forever when Dolt blocks (contention,
// long lock wait, zombie sidecar holding a row lock). bd CLI paths already
// have an execFile timeout (lib/bd.ts), but the mysql2 paths in
// change-detector + lib do not. A handler-level race wraps both surfaces
// in one place.
//
// Why not mysql2's query({ sql, timeout }): mysql2's per-query timeout
// only fires on socket idleness. A Dolt query that's blocked behind a
// contended row lock continues to receive keepalive/progress packets, so
// the inactivity timer never trips. A wall-clock race at the await
// boundary is the correct primitive for "the workspace is unreachable,
// give up and surface a recoverable error to the UI."
//
// The wrapper is applied at handler registration time (handlers/index.ts)
// so every kkrpc method gets the same guarantee, including ones added
// later. Functions that return non-Promise values are passed through
// unchanged; non-function entries (constants, type-only exports the
// transpiler erases) are untouched.

const DEFAULT_TIMEOUT_MS = 30_000

export class HandlerTimeoutError extends Error {
  readonly code = "HANDLER_TIMEOUT"
  readonly handlerName: string
  readonly timeoutMs: number

  constructor(handlerName: string, timeoutMs: number) {
    super(
      `Handler '${handlerName}' timed out after ${timeoutMs}ms (workspace temporarily unreachable; retry?)`,
    )
    this.name = "HandlerTimeoutError"
    this.handlerName = handlerName
    this.timeoutMs = timeoutMs
  }
}

type AnyAsyncFn = (...args: never[]) => Promise<unknown>

export function withHandlerTimeout<F extends AnyAsyncFn>(
  fn: F,
  handlerName: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): F {
  const wrapped = async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HandlerTimeoutError(handlerName, timeoutMs))
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([fn(...args), timeoutPromise])
      return result as Awaited<ReturnType<F>>
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return wrapped as unknown as F
}

export function wrapNamespace<NS extends Record<string, unknown>>(
  ns: NS,
  nsName: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): NS {
  const wrapped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(ns)) {
    if (typeof value === "function") {
      wrapped[key] = withHandlerTimeout(value as AnyAsyncFn, `${nsName}.${key}`, timeoutMs)
    } else {
      wrapped[key] = value
    }
  }
  return wrapped as NS
}

export const __TEST_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
