import { expect, test } from "bun:test"

import { createSidecarManager, RpcDeadlineError, type RemoteApi } from "../lib/rpc"

test("sidecar exit rejects an in-flight call and the next call reconnects", async () => {
  let notifyExit: ((code: number | null) => void) | undefined
  let rejectPending: ((error: Error) => void) | undefined
  let spawns = 0
  let destroyed = 0
  let exits = 0

  const manager = createSidecarManager(
    {
      onExit: async (callback) => {
        notifyExit = callback
      },
      spawn: async () => {
        spawns++
      },
      kill: async () => {},
      connect: async () => ({
        api: {
          epics: {
            getEpics: () =>
              new Promise((_, reject) => {
                rejectPending = reject
              }),
          },
        } as unknown as RemoteApi,
        destroy: () => {
          destroyed++
          rejectPending?.(new Error("RPC channel destroyed"))
        },
      }),
    },
    () => {
      exits++
    },
  )

  const firstApi = await manager.getRemoteApi()
  const pending = firstApi.epics.getEpics()
  notifyExit?.(1)
  await expect(pending).rejects.toThrow("RPC channel destroyed")
  expect(destroyed).toBe(1)
  expect(exits).toBe(1)

  const secondApi = await manager.getRemoteApi()
  expect(secondApi).not.toBe(firstApi)
  expect(spawns).toBe(2)
})

test("exit during startup never caches the dead connection", async () => {
  let notifyExit: ((code: number | null) => void) | undefined
  let releaseFirstSpawn: (() => void) | undefined
  let spawns = 0
  let connections = 0

  const manager = createSidecarManager({
    onExit: async (callback) => {
      notifyExit = callback
    },
    spawn: async () => {
      spawns++
      if (spawns === 1)
        await new Promise<void>((resolve) => {
          releaseFirstSpawn = resolve
        })
    },
    kill: async () => {},
    connect: async () => {
      connections++
      return { api: {} as RemoteApi, destroy: () => {} }
    },
  })

  const first = manager.getRemoteApi()
  await new Promise((resolve) => setTimeout(resolve, 0))
  notifyExit?.(1)
  releaseFirstSpawn?.()
  await expect(first).rejects.toThrow("Sidecar exited during startup")
  await manager.getRemoteApi()
  expect(spawns).toBe(2)
  expect(connections).toBe(1)
})

test("failed channel handshake removes the spawned process before retry", async () => {
  let spawns = 0
  let kills = 0
  const manager = createSidecarManager({
    onExit: async () => {},
    spawn: async () => {
      spawns++
    },
    kill: async () => {
      kills++
    },
    connect: async () => {
      if (spawns === 1) throw new Error("handshake failed")
      return { api: {} as RemoteApi, destroy: () => {} }
    },
  })

  await expect(manager.getRemoteApi()).rejects.toThrow("handshake failed")
  expect(kills).toBe(1)
  await manager.getRemoteApi()
  expect(spawns).toBe(2)
})

function crashingRuntime() {
  let notifyExit: ((code: number | null) => void) | undefined
  let spawns = 0
  return {
    exit: () => notifyExit?.(1),
    spawns: () => spawns,
    runtime: {
      onExit: async (callback: (code: number | null) => void) => {
        notifyExit = callback
      },
      spawn: async () => {
        spawns++
      },
      kill: async () => {},
      connect: async () => ({ api: {} as RemoteApi, destroy: () => {} }),
    },
  }
}

test("a sidecar that keeps dying stops auto-reconnecting, and the next connect re-subscribes", async () => {
  const sidecar = crashingRuntime()
  let reconnects = 0
  const clock = 1_000
  const manager = createSidecarManager(sidecar.runtime, () => reconnects++, {
    maxAutoReconnects: 3,
    windowMs: 60_000,
    now: () => clock,
  })

  for (let i = 0; i < 4; i++) {
    await manager.getRemoteApi()
    sidecar.exit()
  }
  // The fourth exit inside the window is torn down but not announced.
  expect(reconnects).toBe(3)

  // An explicit call (Retry, a user action) still respawns, and the new
  // session tells subscribers to re-subscribe: they hold the dead id.
  await manager.getRemoteApi()
  expect(reconnects).toBe(4)
  expect(sidecar.spawns()).toBe(5)
})

test("a successful connect does not reset the budget; time does", async () => {
  const sidecar = crashingRuntime()
  let reconnects = 0
  let clock = 0
  const manager = createSidecarManager(sidecar.runtime, () => reconnects++, {
    maxAutoReconnects: 1,
    windowMs: 60_000,
    now: () => clock,
  })

  await manager.getRemoteApi()
  sidecar.exit() // 1st exit: announced
  await manager.getRemoteApi()
  sidecar.exit() // 2nd exit in window: suppressed
  expect(reconnects).toBe(1)

  await manager.getRemoteApi() // connect after suppression: announced once
  expect(reconnects).toBe(2)
  sidecar.exit() // still inside the window: suppressed, even though it connected
  expect(reconnects).toBe(2)

  await manager.getRemoteApi() // re-subscribe for the suppressed exit
  expect(reconnects).toBe(3)
  clock += 60_001
  sidecar.exit() // earlier exits aged out: announced again
  expect(reconnects).toBe(4)
})

// ── A sidecar that is alive but not answering (beadbox-x3y) ────────────────
//
// No exit event ever arrives for such a process, and killing it through the
// plugin emits none either, so the manager's deadline and restart() are the
// only way back. The fake runtime below answers `ping` according to `mode`,
// and records spawns, kills, destroyed sessions and the order they ran in.

type Mode = "answer" | "wedged" | "slow"

function aliveRuntime() {
  let mode: Mode = "answer"
  let connectMode: "ok" | "wedged" = "ok"
  let spawns = 0
  let kills = 0
  let destroyed = 0
  let releaseKill: (() => void) | undefined
  let holdKill = false
  const order: string[] = []
  const pendingRejects = new Set<(error: Error) => void>()

  const runtime = {
    onExit: async () => {},
    spawn: async () => {
      spawns++
      order.push(`spawn${spawns}`)
    },
    kill: async () => {
      kills++
      order.push("kill-start")
      if (holdKill) await new Promise<void>((resolve) => { releaseKill = resolve })
      order.push("kill-done")
    },
    connect: async () => {
      if (connectMode === "wedged") await new Promise(() => {})
      const session = spawns
      return {
        api: {
          health: {
            ping: () => {
              if (mode === "answer") return Promise.resolve(`pong from sidecar ${session}`)
              if (mode === "slow") return new Promise((r) => setTimeout(() => r(`slow pong from ${session}`), 20))
              return new Promise((_, reject) => pendingRejects.add(reject))
            },
            // One RPC that never answers while the rest of the API does.
            stuck: () => new Promise((_, reject) => pendingRejects.add(reject)),
          },
        } as unknown as RemoteApi,
        destroy: () => {
          destroyed++
          for (const reject of pendingRejects) reject(new Error("RPC channel destroyed"))
          pendingRejects.clear()
        },
      }
    },
  }
  return {
    runtime,
    set mode(m: Mode) { mode = m },
    set connectMode(m: "ok" | "wedged") { connectMode = m },
    set holdKill(h: boolean) { holdKill = h },
    releaseKill: () => releaseKill?.(),
    counts: () => ({ spawns, kills, destroyed }),
    order,
  }
}

const ping = (api: RemoteApi) => (api as unknown as { health: { ping: () => Promise<string> } }).health.ping()

test("a wedged sidecar: the call fails at the deadline, the sidecar is restarted, and the next call is answered", async () => {
  const sidecar = aliveRuntime()
  let resubscribes = 0
  const manager = createSidecarManager(sidecar.runtime, () => resubscribes++, { callDeadlineMs: 50 })

  expect(await manager.call(ping)).toBe("pong from sidecar 1")
  sidecar.mode = "wedged"
  const started = Date.now()
  await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError)
  expect(Date.now() - started).toBeLessThan(1_000)
  // Everything an exit event would have done, done by the manager itself.
  expect(sidecar.counts()).toEqual({ spawns: 1, kills: 1, destroyed: 1 })
  expect(resubscribes).toBe(1)

  sidecar.mode = "answer"
  expect(await manager.call(ping)).toBe("pong from sidecar 2")
  expect(sidecar.counts().spawns).toBe(2)
})

test("a slow reply inside the deadline restarts nothing", async () => {
  const sidecar = aliveRuntime()
  const manager = createSidecarManager(sidecar.runtime, () => {}, { callDeadlineMs: 500 })
  sidecar.mode = "slow"
  expect(await manager.call(ping)).toBe("slow pong from 1")
  expect(sidecar.counts()).toEqual({ spawns: 1, kills: 0, destroyed: 0 })
})

test("concurrent calls to one wedged sidecar restart it exactly once", async () => {
  const sidecar = aliveRuntime()
  let resubscribes = 0
  const manager = createSidecarManager(sidecar.runtime, () => resubscribes++, { callDeadlineMs: 50 })
  await manager.call(ping)
  sidecar.mode = "wedged"
  const results = await Promise.allSettled([manager.call(ping), manager.call(ping), manager.call(ping)])
  expect(results.every((r) => r.status === "rejected")).toBe(true)
  expect(sidecar.counts().kills).toBe(1)
  expect(resubscribes).toBe(1)
})

test("a wedged channel handshake is covered by the deadline too", async () => {
  const sidecar = aliveRuntime()
  const manager = createSidecarManager(sidecar.runtime, () => {}, { callDeadlineMs: 50 })
  sidecar.connectMode = "wedged"
  await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError)
  expect(sidecar.counts().kills).toBe(1)
  sidecar.connectMode = "ok"
  expect(await manager.call(ping)).toBe("pong from sidecar 2")
})

test("the next spawn waits for the restart's kill to finish", async () => {
  const sidecar = aliveRuntime()
  const manager = createSidecarManager(sidecar.runtime, () => {}, { callDeadlineMs: 50 })
  await manager.call(ping)
  sidecar.mode = "wedged"
  sidecar.holdKill = true
  await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError)
  sidecar.mode = "answer"
  const next = manager.call(ping)
  await new Promise((r) => setTimeout(r, 10))
  expect(sidecar.counts().spawns).toBe(1) // still waiting on the kill
  sidecar.releaseKill()
  expect(await next).toBe("pong from sidecar 2")
  expect(sidecar.order).toEqual(["spawn1", "kill-start", "kill-done", "spawn2"])
})

test("restarts count toward the respawn budget", async () => {
  const sidecar = aliveRuntime()
  let resubscribes = 0
  const manager = createSidecarManager(sidecar.runtime, () => resubscribes++, {
    callDeadlineMs: 30,
    maxAutoReconnects: 1,
    windowMs: 60_000,
    now: () => 1_000,
  })
  sidecar.mode = "wedged"
  await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError) // 1st: announced
  expect(resubscribes).toBe(1)
  await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError) // 2nd in window: not announced
  expect(resubscribes).toBe(1)
  sidecar.mode = "answer"
  await manager.call(ping) // the connect after a suppressed loss re-subscribes
  expect(resubscribes).toBe(2)
})

test("with maxConsecutiveMisses=2, one miss restarts nothing and a reply resets the count", async () => {
  const sidecar = aliveRuntime()
  const manager = createSidecarManager(sidecar.runtime, () => {}, { callDeadlineMs: 30, maxConsecutiveMisses: 2 })
  sidecar.mode = "wedged"
  await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError)
  expect(sidecar.counts().kills).toBe(0)
  sidecar.mode = "answer"
  await manager.call(ping) // resets the count
  sidecar.mode = "wedged"
  await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError)
  expect(sidecar.counts().kills).toBe(0)
  await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError)
  expect(sidecar.counts().kills).toBe(1)
})

test("restart() on demand tears down the session and the next call reconnects", async () => {
  const sidecar = aliveRuntime()
  let resubscribes = 0
  const manager = createSidecarManager(sidecar.runtime, () => resubscribes++)
  await manager.call(ping)
  manager.restart()
  expect(sidecar.counts()).toEqual({ spawns: 1, kills: 1, destroyed: 1 })
  expect(resubscribes).toBe(1)
  expect(await manager.call(ping)).toBe("pong from sidecar 2")
})

// ── Deadline restarts must be bounded (beadbox-hia) ─────────────────────────

const stuck = (api: RemoteApi) => (api as unknown as { health: { stuck: () => Promise<string> } }).health.stuck()

test("a call that misses the deadline every ~50s stops restarting at the budget", async () => {
  const sidecar = aliveRuntime()
  let clock = 0
  const manager = createSidecarManager(sidecar.runtime, () => {}, { callDeadlineMs: 20, now: () => clock })
  sidecar.mode = "wedged"
  for (let i = 0; i < 10; i++) {
    await expect(manager.call(ping, "health.ping")).rejects.toBeInstanceOf(RpcDeadlineError)
    clock += 50_000
  }
  // 3/60s could never fill at this spacing, and the budget gated nothing.
  expect(sidecar.counts().kills).toBe(3)
})

test("the deadline budget slides: a sidecar wedged later is still recovered", async () => {
  const sidecar = aliveRuntime()
  let clock = 0
  const manager = createSidecarManager(sidecar.runtime, () => {}, { callDeadlineMs: 20, now: () => clock })
  sidecar.mode = "wedged"
  for (let i = 0; i < 4; i++) await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError)
  expect(sidecar.counts().kills).toBe(3)
  clock += 10 * 60_000 + 1
  await expect(manager.call(ping)).rejects.toBeInstanceOf(RpcDeadlineError)
  expect(sidecar.counts().kills).toBe(4)
  sidecar.mode = "answer"
  expect(await manager.call(ping)).toBe("pong from sidecar 5")
})

test("one slow RPC does not restart a sidecar that is answering other calls", async () => {
  const sidecar = aliveRuntime()
  let resubscribes = 0
  const manager = createSidecarManager(sidecar.runtime, () => resubscribes++, { callDeadlineMs: 80 })
  await manager.call(ping)
  const slow = manager.call(stuck, "health.stuck")
  await new Promise((r) => setTimeout(r, 10))
  expect(await manager.call(ping)).toBe("pong from sidecar 1")
  await expect(slow).rejects.toBeInstanceOf(RpcDeadlineError)
  expect(sidecar.counts()).toEqual({ spawns: 1, kills: 0, destroyed: 0 })
  expect(resubscribes).toBe(0)
  expect(await manager.call(ping)).toBe("pong from sidecar 1")
})

test("the deadline error and its warning name the RPC that missed it", async () => {
  const sidecar = aliveRuntime()
  const manager = createSidecarManager(sidecar.runtime, () => {}, { callDeadlineMs: 20 })
  sidecar.mode = "wedged"
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "))
  try {
    const error = await manager.call(ping, "beads.list").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcDeadlineError)
    expect((error as RpcDeadlineError).method).toBe("beads.list")
    expect((error as Error).message).toContain("rpc.beads.list")
  } finally {
    console.warn = original
  }
  expect(warnings.some((w) => w.includes("beads.list") && w.includes("restarting"))).toBe(true)
})
