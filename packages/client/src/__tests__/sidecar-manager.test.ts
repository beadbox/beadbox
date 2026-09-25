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
