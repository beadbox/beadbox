// The Commands-tab rpc tap must not echo credentials (beadbox-hqtp).
//
// The tapped proxy summarises every argument into the bd_command event the
// Commands tab renders, so a password passed to a workspaces method showed
// there in plain text. Listed methods now emit one "<redacted>" placeholder
// in place of all their arguments; every other method is unchanged.
//
// Drives the real proxy through the _buildTauriRpc seam with a fake manager,
// so no module is mocked (bb-jjdw) and nothing leaks into other files.

import { afterEach, describe, expect, test } from "bun:test"
import type { BdCommandEvent } from "../lib/console-types"
import { _buildTauriRpc, type RemoteApi, setRpcTap } from "../lib/rpc"

const SECRET = "s3cret-hunter2"

type Fn = (...a: unknown[]) => Promise<unknown>

function fakeRpc(impl: (ns: string, method: string, args: unknown[]) => Promise<unknown>) {
  const api = new Proxy(
    {},
    {
      get: (_t, ns: string) =>
        new Proxy(
          {},
          {
            get:
              (_u, method: string) =>
              (...args: unknown[]) =>
                impl(ns, method, args),
          },
        ),
    },
  )
  return _buildTauriRpc({
    call: (invoke) => invoke(api as unknown as RemoteApi) as never,
  }) as unknown as Record<string, Record<string, Fn>>
}

function captureTap(): BdCommandEvent[] {
  const events: BdCommandEvent[] = []
  setRpcTap((evt) => events.push(evt))
  return events
}

afterEach(() => {
  setRpcTap(null)
})

// The five server handlers that take a password (arch verdict on the bead).
const LISTED_CALLS: Array<[string, unknown[]]> = [
  ["discoverServerDatabases", ["db.example", 3307, "admin", SECRET, true]],
  ["addServerWorkspace", ["db.example", 3307, "beads", "admin", SECRET, false]],
  ["setServerPassword", ["db.example:3307/beads", SECRET]],
  ["replaceLocalWithServer", ["ws-1", "db.example", 3307, "beads", "admin", false, SECRET]],
  ["updateServerConnection", ["ws-1", "db.example", 3307, "admin", SECRET, false]],
]

describe("rpc tap redacts credential-carrying methods", () => {
  test("addServerWorkspace: the event carries no argument text", async () => {
    const events = captureTap()
    const rpc = fakeRpc(async () => ({ success: true }))
    await rpc.workspaces.addServerWorkspace("h", 1, "db", "u", SECRET, false)
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0])).not.toContain(SECRET)
    expect(events[0].args).toEqual(["addServerWorkspace", "<redacted>"])
    expect(events[0].exitCode).toBe(0)
  })

  test("setServerPassword: the event carries no argument text", async () => {
    const events = captureTap()
    const rpc = fakeRpc(async () => undefined)
    await rpc.workspaces.setServerPassword("h:1/db", SECRET)
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0])).not.toContain(SECRET)
    expect(events[0].args).toEqual(["setServerPassword", "<redacted>"])
  })

  test("a listed call that rejects: the failure event carries no argument text", async () => {
    const events = captureTap()
    const rpc = fakeRpc(async () => {
      throw new Error("connection refused")
    })
    await expect(
      rpc.workspaces.addServerWorkspace("h", 1, "db", "u", SECRET, false),
    ).rejects.toThrow("connection refused")
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0])).not.toContain(SECRET)
    expect(events[0].args).toEqual(["addServerWorkspace", "<redacted>"])
    expect(events[0].exitCode).toBe(1)
    expect(events[0].stderr).toBe("connection refused")
  })

  for (const [method, args] of LISTED_CALLS) {
    test(`workspaces.${method}: no argument text on either emit site`, async () => {
      const events = captureTap()
      await fakeRpc(async () => ({ success: true })).workspaces[method](...args)
      await fakeRpc(async () => {
        throw new Error("boom")
      })
        .workspaces[method](...args)
        .catch(() => {})
      expect(events.map((e) => e.exitCode)).toEqual([0, 1])
      for (const evt of events) {
        expect(evt.args).toEqual([method, "<redacted>"])
        const text = JSON.stringify(evt)
        expect(text).not.toContain(SECRET)
        expect(text).not.toContain("admin")
        expect(text).not.toContain("db.example")
      }
    })
  }
})

describe("rpc tap leaves every other method unchanged", () => {
  // The same call on a namespace that is not workspaces, and an unlisted
  // workspaces method: arguments are summarised exactly as before the fix.
  const ARGS = ["bb-1", "x".repeat(50), { a: 1 }, null, undefined, 3, true]
  const SUMMARY = ["bb-1", `${"x".repeat(37)}...`, '{"a":1}', "null", "undefined", "3", "true"]

  for (const [ns, method] of [
    ["beads", "updateBeadStatus"],
    ["workspaces", "getWorkspaces"],
  ]) {
    test(`${ns}.${method}: summarised arguments on both emit sites`, async () => {
      const events = captureTap()
      await fakeRpc(async () => [1, 2])[ns][method](...ARGS)
      await fakeRpc(async () => {
        throw new Error("nope")
      })
        [ns][method](...ARGS)
        .catch(() => {})
      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        command: ns,
        args: [method, ...SUMMARY],
        exitCode: 0,
        resultSummary: "array(2)",
        stderr: null,
        source: "app",
      })
      expect(events[1]).toMatchObject({
        command: ns,
        args: [method, ...SUMMARY],
        exitCode: 1,
        resultSummary: null,
        stderr: "nope",
      })
    })
  }

  test("the console namespace still emits nothing from the proxy", async () => {
    const events = captureTap()
    await fakeRpc(async () => ({})).console.run({ command: "show bb-1" })
    expect(events).toHaveLength(0)
  })
})
