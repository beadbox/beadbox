// Saved server passwords reach every sidecar process (beadbox-ct1).
//
// The keychain write always worked; nothing read it back, so every relaunch
// (and every crash respawn) re-prompted. The read-back is: on each new sidecar
// session, list the saved credential keys, read each password from the
// keychain, and hand it to the sidecar's in-memory map — before any other
// call (the startup health check) can run without it.

import { describe, expect, mock, test } from "bun:test"

import { createSidecarManager, type RemoteApi, SIDECAR_MANAGER_OPTIONS } from "../lib/rpc"
import { hydrateSavedPasswords } from "../lib/tauri-credentials"

const KEY = { credentialKey: "127.0.0.1:14610/pw1/qa1pw", passwordMapKey: "127.0.0.1:14610/pw1" }

function fakeApi(calls: string[], keys = [KEY]) {
  return {
    workspaces: {
      getSavedCredentialKeys: mock(async () => {
        calls.push("getSavedCredentialKeys")
        return keys
      }),
      setServerPassword: mock(async (mapKey: string, _pw: string) => {
        calls.push(`setServerPassword:${mapKey}`)
      }),
    },
    health: {
      runStartupHealth: mock(async () => {
        calls.push("runStartupHealth")
        return {}
      }),
    },
  } as unknown as RemoteApi
}

describe("hydrateSavedPasswords", () => {
  test("hands each keychain password to the sidecar under its map key", async () => {
    const calls: string[] = []
    const api = fakeApi(calls)
    const read = mock(async (credentialKey: string) =>
      credentialKey === KEY.credentialKey ? "s3cret" : null,
    )
    await hydrateSavedPasswords(api, read)
    expect(read).toHaveBeenCalledWith(KEY.credentialKey)
    expect(api.workspaces.setServerPassword).toHaveBeenCalledWith(KEY.passwordMapKey, "s3cret")
  })

  test("a key with no keychain item is skipped quietly", async () => {
    const calls: string[] = []
    const api = fakeApi(calls)
    await hydrateSavedPasswords(api, async () => null)
    expect(api.workspaces.setServerPassword).not.toHaveBeenCalled()
  })

  test("one failing keychain read does not stop the others", async () => {
    const calls: string[] = []
    const other = { credentialKey: "h:1/db2/u", passwordMapKey: "h:1/db2" }
    const api = fakeApi(calls, [KEY, other])
    await hydrateSavedPasswords(api, async (k) => {
      if (k === KEY.credentialKey) throw new Error("keychain locked")
      return "pw2"
    })
    expect(api.workspaces.setServerPassword).toHaveBeenCalledTimes(1)
    expect(api.workspaces.setServerPassword).toHaveBeenCalledWith("h:1/db2", "pw2")
  })
})

function manager(onConnect: (api: RemoteApi) => Promise<void>, calls: string[], timeoutMs = 50) {
  let notifyExit: ((code: number | null) => void) | undefined
  const m = createSidecarManager(
    {
      onExit: async (cb) => {
        notifyExit = cb
      },
      spawn: async () => {},
      kill: async () => {},
      connect: async () => ({ api: fakeApi(calls), destroy: () => {} }),
    },
    () => {},
    { onConnect, onConnectTimeoutMs: timeoutMs },
  )
  return { m, exit: () => notifyExit?.(1) }
}

describe("sidecar manager runs the password read-back on every new sidecar", () => {
  test("before the first call the page makes (the startup health check)", async () => {
    const calls: string[] = []
    const { m } = manager((api) => hydrateSavedPasswords(api, async () => "s3cret"), calls)
    const api = await m.getRemoteApi()
    await api.health.runStartupHealth()
    expect(calls).toEqual([
      "getSavedCredentialKeys",
      `setServerPassword:${KEY.passwordMapKey}`,
      "runStartupHealth",
    ])
  })

  test("again after a crash respawn: the new process starts with an empty map", async () => {
    const calls: string[] = []
    const { m, exit } = manager((api) => hydrateSavedPasswords(api, async () => "s3cret"), calls)
    await m.getRemoteApi()
    exit()
    await m.getRemoteApi()
    expect(calls.filter((c) => c.startsWith("setServerPassword"))).toHaveLength(2)
  })

  test("a keychain read that never answers (an OS prompt) cannot hang the app", async () => {
    const calls: string[] = []
    const { m } = manager(() => new Promise<void>(() => {}), calls, 30)
    const started = Date.now()
    await m.getRemoteApi()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("a failing read-back does not stop the sidecar from being usable", async () => {
    const calls: string[] = []
    const { m } = manager(async () => {
      throw new Error("boom")
    }, calls)
    const api = await m.getRemoteApi()
    await api.health.runStartupHealth()
    expect(calls).toContain("runStartupHealth")
  })
})

test("the app's sidecar manager is wired to the password read-back", () => {
  expect(SIDECAR_MANAGER_OPTIONS.onConnect).toBe(hydrateSavedPasswords)
})
