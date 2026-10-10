// beadbox-z04: after the host reloads a page WebKit killed, the new page finds
// the sidecar the previous page spawned still running. It attaches to it (one
// sidecar per app instance) and drops the previous page's subscriptions
// before anything subscribes; it never spawns a second one.

import { expect, test } from "bun:test"

import { createSidecarManager, type RemoteApi, SIDECAR_MANAGER_OPTIONS } from "../lib/rpc"

function harness(isRunning?: () => Promise<boolean>) {
  const log: string[] = []
  let notifyExit: ((code: number | null) => void) | undefined
  const manager = createSidecarManager(
    {
      onExit: async (callback) => {
        notifyExit = callback
      },
      spawn: async () => {
        log.push("spawn")
      },
      kill: async () => {
        log.push("kill")
      },
      connect: async () => {
        log.push("connect")
        return { api: {} as RemoteApi, destroy: () => {} }
      },
      isRunning: isRunning
        ? async () => {
            log.push("isRunning")
            return isRunning()
          }
        : undefined,
    },
    undefined,
    {
      onAttach: async () => {
        await new Promise((r) => setTimeout(r, 10))
        log.push("onAttach")
      },
      onConnect: async () => {
        log.push("onConnect")
      },
    },
  )
  return { manager, log, exit: (code: number | null) => notifyExit?.(code) }
}

test("a running sidecar is attached to, not spawned; its old subscriptions go first", async () => {
  const { manager, log } = harness(async () => true)
  await manager.getRemoteApi()
  log.push("api")
  expect(log).toEqual(["isRunning", "connect", "onAttach", "onConnect", "api"])
})

test("no sidecar running: spawn as before, and nothing to drop", async () => {
  const { manager, log } = harness(async () => false)
  await manager.getRemoteApi()
  expect(log).toEqual(["isRunning", "spawn", "connect", "onConnect"])
})

test("a status check that fails counts as not running", async () => {
  const { manager, log } = harness(async () => {
    throw new Error("process not found: beadbox-sidecar")
  })
  await manager.getRemoteApi()
  expect(log).toEqual(["isRunning", "spawn", "connect", "onConnect"])
})

test("a runtime without isRunning spawns as before", async () => {
  const { manager, log } = harness()
  await manager.getRemoteApi()
  expect(log).toEqual(["spawn", "connect", "onConnect"])
})

test("only the first start of a page may attach: after an exit it spawns", async () => {
  const { manager, log, exit } = harness(async () => true)
  await manager.getRemoteApi()
  exit(1)
  log.length = 0
  await manager.getRemoteApi()
  expect(log).toEqual(["spawn", "connect", "onConnect"])
})

test("the app's options drop the previous page's subscriptions on attach", async () => {
  let attachedCalls = 0
  const api = {
    session: {
      attached: async () => {
        attachedCalls++
        return { stopped: 1 }
      },
    },
  } as unknown as RemoteApi
  await SIDECAR_MANAGER_OPTIONS.onAttach?.(api)
  expect(attachedCalls).toBe(1)
})
