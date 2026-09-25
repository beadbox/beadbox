import { expect, test } from "bun:test"

import { createSidecarManager, type RemoteApi } from "../lib/rpc"

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
