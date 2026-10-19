// The test transport's IO must hand kkrpc and the stderr consumers what
// production hands them, whatever chunking the Playwright bridge delivers
// (beadbox-r72.2). Production never sees a partial line: tauri-plugin-js
// reads the sidecar's stdout and stderr with Rust's BufReader::lines() and
// emits one event per line. A pipe relay does not. Two ways that breaks:
//
// - kkrpc 0.6.7 drops any read whose trim() is empty BEFORE reassembling,
//   so a frame whose final "\n" arrives alone is glued to the next frame and
//   neither call ever resolves, with nothing logged (reproduced in the
//   beadbox-r72.1 spike).
// - subscribe.ts and the stamps split each stderr delivery on "\n" and keep
//   only lines that start with the prefix, so a [SUBSCRIPTION:<id>] line
//   split across two chunks is silently lost.
//
// The "sidecar" here is a second kkrpc channel in the same process; the fake
// bridge between them re-chunks the sidecar's stdout and stderr.

import { describe, expect, test } from "bun:test"
import { RPCChannel } from "kkrpc/browser"
import { BindingIo, createTestTransport, type TestBridge } from "../lib/test-transport"

class Queue<T> {
  private items: T[] = []
  private waiters: ((item: T) => void)[] = []
  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }
  next(): Promise<T> {
    if (this.items.length) return Promise.resolve(this.items.shift() as T)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

const never = <T>(): Promise<T> => new Promise<T>(() => {})
type Chunker = (data: string) => string[]

const sidecarApi = {
  echo: async (value: string) => value,
  big: async (length: number) => "x".repeat(length),
}

/** A page-side BindingIo wired to an in-process kkrpc "sidecar" through a re-chunking bridge. */
function link(chunker: Chunker) {
  const toSidecar = new Queue<string>()
  const toPage = new Queue<string>()
  const sidecarIo = {
    name: "fake-sidecar",
    read: () => toSidecar.next(),
    write: async (data: string) => {
      for (const chunk of chunker(data)) toPage.push(chunk)
    },
    on() {},
    off() {},
  }
  new RPCChannel(sidecarIo as never, { expose: sidecarApi })
  const bridge: TestBridge = {
    spawn: async () => 1,
    kill: async () => true,
    status: async () => ({ running: true }),
    write: async (data) => toSidecar.push(data),
    read: () => toPage.next(),
    readStderr: () => never(),
    waitExit: () => never(),
  }
  const io = new BindingIo(() => bridge)
  const api = new RPCChannel<Record<string, never>, typeof sidecarApi>(io, {
    expose: {},
  }).getAPI()
  return { api, io }
}

function within<T>(promise: Promise<T>, ms = 2_000): Promise<T | "timed out"> {
  return Promise.race([
    promise,
    new Promise<"timed out">((r) => setTimeout(() => r("timed out"), ms)),
  ])
}

// Each sidecar write is one whole frame ending in "\n".
const loneNewline: Chunker = (frame) => [frame.slice(0, -1), "\n"]
const thirds: Chunker = (frame) => {
  const a = Math.floor(frame.length / 3)
  return [frame.slice(0, a), frame.slice(a, 2 * a), frame.slice(2 * a)]
}
function coalescePairs(): Chunker {
  let held: string | null = null
  return (frame) => {
    if (held === null) {
      held = frame
      return []
    }
    const both = held + frame
    held = null
    return [both]
  }
}
const pipeChunks: Chunker = (frame) => {
  const out: string[] = []
  for (let i = 0; i < frame.length; i += 65_536) out.push(frame.slice(i, i + 65_536))
  return out
}

describe("BindingIo hands kkrpc whole lines, whatever the bridge's chunking (beadbox-r72.2)", () => {
  test("a frame whose final newline arrives alone still resolves, and so does the next call", async () => {
    const { api } = link(loneNewline)
    expect(await within(api.echo("first"))).toBe("first")
    expect(await within(api.echo("second"))).toBe("second")
  })

  test("frames split mid-line resolve", async () => {
    const { api } = link(thirds)
    expect(await within(api.echo("split"))).toBe("split")
  })

  test("two frames in one chunk both resolve, each with its own reply", async () => {
    const { api } = link(coalescePairs())
    const results = await within(Promise.all([api.echo("a"), api.echo("b")]))
    expect(results).toEqual(["a", "b"])
  })

  test("a 9.5 MB reply in 64 KB pipe chunks arrives intact", async () => {
    const { api } = link(pipeChunks)
    const reply = await within(api.big(9_500_000), 10_000)
    expect(typeof reply === "string" ? reply.length : reply).toBe(9_500_000)
  })

  test("read() never resolves after destroy, so kkrpc's listen loop parks", async () => {
    const { io } = link(thirds)
    await io.destroy()
    expect(await within(io.read(), 100)).toBe("timed out")
  })
})

type StreamItem = string | { eof: true } | null

function stderrTransport(chunks: StreamItem[]) {
  const stderr = new Queue<StreamItem>()
  for (const chunk of chunks) stderr.push(chunk)
  const emit = (chunk: StreamItem) => stderr.push(chunk)
  let exited: (code: number | null) => void = () => {}
  let waitExitCalls = 0
  const bridge: TestBridge = {
    spawn: async () => 1,
    kill: async () => true,
    status: async () => ({ running: false }),
    write: async () => true,
    read: () => never(),
    readStderr: () => stderr.next(),
    waitExit: () => {
      waitExitCalls++
      return new Promise((resolve) => (exited = resolve))
    },
  }
  return {
    transport: createTestTransport(() => bridge),
    emit,
    exit: (code: number | null) => exited(code),
    waitExitCalls: () => waitExitCalls,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 10))

describe("onStderr delivers whole lines without their newline, as tauri-plugin-js does", () => {
  test("a subscription line split across two stderr chunks reaches the listener whole", async () => {
    const line = '[SUBSCRIPTION:abc] {"type":"change","timestamp":1}'
    const { transport } = stderrTransport([line.slice(0, 20), `${line.slice(20)}\n`])
    const got: string[] = []
    await transport.onStderr("beadbox-sidecar", (data) => got.push(data))
    await flush()
    expect(got).toEqual([line])
  })

  test("several lines in one chunk arrive as separate deliveries", async () => {
    const { transport } = stderrTransport(["one\ntwo\nthr", "ee\n"])
    const got: string[] = []
    await transport.onStderr("beadbox-sidecar", (data) => got.push(data))
    await flush()
    expect(got).toEqual(["one", "two", "three"])
  })

  test("every listener gets each line once, and an unlistened one stops receiving", async () => {
    const { transport, emit } = stderrTransport([])
    const first: string[] = []
    const second: string[] = []
    const unlisten = await transport.onStderr("beadbox-sidecar", (d) => first.push(d))
    await transport.onStderr("beadbox-sidecar", (d) => second.push(d))
    emit("a\n")
    await flush()
    unlisten()
    emit("b\n")
    await flush()
    expect(first).toEqual(["a"])
    expect(second).toEqual(["a", "b"])
  })
})

describe("the end of a child's stream flushes its last line, as BufReader::lines() does at EOF", () => {
  test("a final stderr line with no newline is delivered when the stream ends", async () => {
    const { transport } = stderrTransport(["first\nlast words, no newline", { eof: true }])
    const got: string[] = []
    await transport.onStderr("beadbox-sidecar", (data) => got.push(data))
    await flush()
    expect(got).toEqual(["first", "last words, no newline"])
  })

  test("stderr keeps flowing after an end: a respawned sidecar's lines still arrive", async () => {
    const { transport, emit } = stderrTransport(["old\n", { eof: true }])
    const got: string[] = []
    await transport.onStderr("beadbox-sidecar", (data) => got.push(data))
    emit("new\n")
    await flush()
    expect(got).toEqual(["old", "new"])
  })

  test("a final stdout frame with no newline reaches kkrpc when the stream ends", async () => {
    const items = new Queue<StreamItem>()
    items.push('{"partial":')
    items.push({ eof: true })
    const io = new BindingIo(() => ({
      spawn: async () => 1,
      kill: async () => true,
      status: async () => ({ running: true }),
      write: async () => true,
      read: () => items.next(),
      readStderr: () => never(),
      waitExit: () => never(),
    }))
    expect(await within(io.read(), 200)).toBe('{"partial":\n')
  })
})

describe("the test runtime's exit path", () => {
  test("waits for an exit only after a spawn, and reports the code", async () => {
    const { transport, exit, waitExitCalls } = stderrTransport([])
    const codes: (number | null)[] = []
    await transport.runtime.onExit((code) => codes.push(code))
    await flush()
    expect(waitExitCalls()).toBe(0)
    await transport.runtime.spawn()
    expect(waitExitCalls()).toBe(1)
    exit(137)
    await flush()
    expect(codes).toEqual([137])
  })
})
