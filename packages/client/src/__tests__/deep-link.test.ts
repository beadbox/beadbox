import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// The Tauri modules are replaced before the module under test imports them.
let invokeAnswer: unknown = null
const invokeCalls: string[] = []
let listener: (() => void) | null = null
let unlistened = 0
let listenedFor = ""

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (name: string) => {
    invokeCalls.push(name)
    return typeof invokeAnswer === "function" ? (invokeAnswer as () => unknown)() : invokeAnswer
  },
}))
mock.module("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: () => void) => {
    listenedFor = name
    listener = cb
    return () => {
      unlistened++
    }
  },
}))

const { beadIdFrom, OPEN_BEAD_EVENT, subscribeDeepLinks } = await import("../lib/deep-link")
const settle = () => new Promise((r) => setTimeout(r, 0))
const win = window as unknown as Record<string, unknown>

describe("beadIdFrom", () => {
  test("accepts a bead id and nothing else", () => {
    expect(beadIdFrom({ id: "auto-eeb" })).toBe("auto-eeb")
    expect(beadIdFrom({ id: "beadbox-d6l.2" })).toBe("beadbox-d6l.2")
    expect(beadIdFrom(null)).toBeNull()
    expect(beadIdFrom({})).toBeNull()
    expect(beadIdFrom({ id: 5 })).toBeNull()
    expect(beadIdFrom({ id: "" })).toBeNull()
    expect(beadIdFrom({ id: "a b" })).toBeNull()
    expect(beadIdFrom({ id: "../x" })).toBeNull()
    expect(beadIdFrom({ id: "a".repeat(129) })).toBeNull()
  })
})

describe("subscribeDeepLinks", () => {
  beforeEach(() => {
    invokeAnswer = null
    invokeCalls.length = 0
    listener = null
    unlistened = 0
    listenedFor = ""
    win.__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete win.__TAURI_INTERNALS__
  })

  test("does nothing outside the Tauri shell", async () => {
    delete win.__TAURI_INTERNALS__
    const opened: string[] = []
    subscribeDeepLinks((id) => opened.push(id))()
    await settle()
    expect(invokeCalls).toEqual([])
    expect(opened).toEqual([])
  })

  test("opens the link that launched the app", async () => {
    invokeAnswer = { id: "auto-eeb" }
    const opened: string[] = []
    subscribeDeepLinks((id) => opened.push(id))
    await settle()
    expect(invokeCalls).toEqual(["take_pending_open"])
    expect(opened).toEqual(["auto-eeb"])
  })

  test("opens a link that arrives later, once per event", async () => {
    let calls = 0
    invokeAnswer = () => (++calls === 1 ? null : { id: "auto-n5l" })
    const opened: string[] = []
    subscribeDeepLinks((id) => opened.push(id))
    await settle()
    expect(listenedFor).toBe(OPEN_BEAD_EVENT)
    expect(opened).toEqual([])
    listener?.()
    await settle()
    expect(opened).toEqual(["auto-n5l"])
  })

  test("refuses an id the host should never have sent", async () => {
    invokeAnswer = { id: "x; rm -rf" }
    const opened: string[] = []
    subscribeDeepLinks((id) => opened.push(id))
    await settle()
    expect(opened).toEqual([])
  })

  test("stops listening when unsubscribed", async () => {
    const stop = subscribeDeepLinks(() => {})
    await settle()
    stop()
    expect(unlistened).toBe(1)
  })
})
