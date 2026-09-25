// Unit tests for useChangeSubscription (lib/subscribe.ts).
//
// Strategy:
//   - Inject mocks via the explicit test seams (_setRpc, _setListenStderr,
//     _setRuntimeCheck) that subscribe.ts exposes. This avoids relying on
//     bun:test's mock.module API surface, which differs from vitest's
//     vi.mock — keeps the test portable across runners.
//   - Render the hook via React's `act` + `createRoot` against a real
//     happy-dom document; we don't need full @testing-library/react for a
//     hook that has no DOM output.
//   - Mount/unmount lifecycle is exercised via root.unmount() and
//     consecutive root.render() calls.
//
// Cases covered (per bead AC):
//   1. mount → start called with workspacePath; listener attached
//   2. matching event → invalidates queries
//   3. non-matching stderr line → no invalidation
//   4. unmount → stop called with the captured id; listener detached
//   5. StrictMode double-mount → no orphan after second unmount

// IS_REACT_ACT_ENVIRONMENT is set by _test-globals.ts (the bunfig preload)
// before React loads — needs to be in place before react-dom/client init.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { formatLine, type SubscriptionEvent } from "@beadbox/server/subscribe-protocol"
import posthog from "posthog-js"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { queryClient } from "../lib/query-client"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import {
  _getSubscriptionChangeCount,
  _resetListenStderr,
  _resetRuntimeCheck,
  _resetSubscriptionChangeCount,
  _setListenStderr,
  _setRuntimeCheck,
  useChangeSubscription,
  useSubscriptionChangeSignal,
} from "../lib/subscribe"

interface RpcMocks {
  start: ReturnType<typeof mock>
  stop: ReturnType<typeof mock>
}

interface ListenMocks {
  unlisten: ReturnType<typeof mock>
  attach: ReturnType<typeof mock>
  fire: (line: string) => void
}

let container: HTMLElement

// bb-jjdw: use the shared Window installed by _test-globals.ts (bunfig
// preload) instead of `new Window()`. Reassigning globalThis.window/document
// breaks the contract the preload comment documents — when this file ran
// before the suite's React-tree tests, the override unbound bun:test's
// hooks from the document the rest of the suite queried (custom-statuses-
// manager, bead-table-bulk-toolbar etc.).
function setupDom(): void {
  container = document.createElement("div")
  document.body.appendChild(container)
}

function teardownDom(): void {
  if (container?.parentNode) container.parentNode.removeChild(container)
}

function installRpcMock(idForStart = "test-id-1"): RpcMocks {
  const start = mock(async (_workspacePath: string) => ({ id: idForStart }))
  const stop = mock(async (_id: string) => undefined)
  // Build a partial RemoteApi: only `subscribe` is exercised by the
  // subscription hook; other namespaces stub to a Proxy that throws if
  // hit (proves the hook never reaches into them).
  const trapNamespace = new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error("test rpc: unexpected namespace access")
        }
      },
    },
  )
  const fakeRpc = {
    activity: trapNamespace,
    beads: trapNamespace,
    diagnostics: trapNamespace,
    epics: trapNamespace,
    formulas: trapNamespace,
    health: trapNamespace,
    molecules: trapNamespace,
    recovery: trapNamespace,
    subscribe: { start, stop },
    system: trapNamespace,
    workspaces: trapNamespace,
  } as unknown as RemoteApi
  _setRpc(fakeRpc)
  return { start, stop }
}

function installListenMock(): ListenMocks {
  let cb: ((data: string) => void) | null = null
  const unlisten = mock(() => undefined)
  const attach = mock(async (_name: string, fn: (data: string) => void) => {
    cb = fn
    return unlisten as unknown as () => void
  })
  _setListenStderr(attach as unknown as Parameters<typeof _setListenStderr>[0])
  return {
    unlisten,
    attach,
    fire: (line: string) => {
      if (!cb) throw new Error("listener not yet attached")
      cb(line)
    },
  }
}

function HookHost({
  workspacePath,
  onEvent,
}: {
  workspacePath: string | null
  onEvent?: (e: SubscriptionEvent) => void
}): ReactNode {
  useChangeSubscription(workspacePath, onEvent ? { onEvent } : undefined)
  return null
}

async function flushMicrotasks(): Promise<void> {
  // Two microtask hops: one for start's Promise resolution, one for
  // listenStderrImpl's Promise resolution.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe("useChangeSubscription", () => {
  let root: Root
  let rpcMocks: RpcMocks
  let listenMocks: ListenMocks

  beforeEach(() => {
    setupDom()
    _setRuntimeCheck(() => true)
    rpcMocks = installRpcMock("test-id-1")
    listenMocks = installListenMock()
    root = createRoot(container)
  })

  afterEach(() => {
    try {
      root.unmount()
    } catch {
      /* already unmounted */
    }
    teardownDom()
    _resetRpc()
    _resetListenStderr()
    _resetRuntimeCheck()
    _resetSubscriptionChangeCount()
    queryClient.clear()
  })

  test("mount calls subscribe.start with workspacePath and attaches stderr listener", async () => {
    await act(async () => {
      root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
    })
    await flushMicrotasks()
    expect(rpcMocks.start).toHaveBeenCalledTimes(1)
    expect(rpcMocks.start.mock.calls[0]).toEqual(["/ws/a"])
    expect(listenMocks.attach).toHaveBeenCalledTimes(1)
  })

  test("sidecar exit reconnects the subscription and requests a fresh view", async () => {
    const events: SubscriptionEvent[] = []
    const onEvent = (event: SubscriptionEvent) => events.push(event)
    await act(async () => {
      root.render(createElement(HookHost, { workspacePath: "/ws/a", onEvent }))
    })
    await flushMicrotasks()

    await act(async () => {
      window.dispatchEvent(new Event("beadbox:sidecar-exit"))
    })
    await flushMicrotasks()

    expect(rpcMocks.start).toHaveBeenCalledTimes(2)
    expect(listenMocks.attach).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "change", trigger: "sidecar-reconnected" })
  })

  test("matching SUBSCRIPTION line invalidates queries via onEvent", async () => {
    const events: SubscriptionEvent[] = []
    await act(async () => {
      root.render(
        createElement(HookHost, {
          workspacePath: "/ws/a",
          onEvent: (e) => events.push(e),
        }),
      )
    })
    await flushMicrotasks()
    const line = formatLine("test-id-1", { type: "change", timestamp: 123 })
    listenMocks.fire(line)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: "change", timestamp: 123 })
  })

  test("non-matching stderr line is ignored", async () => {
    const events: SubscriptionEvent[] = []
    await act(async () => {
      root.render(
        createElement(HookHost, {
          workspacePath: "/ws/a",
          onEvent: (e) => events.push(e),
        }),
      )
    })
    await flushMicrotasks()
    listenMocks.fire("[boot] sidecar starting pid=12345\n")
    listenMocks.fire("[change-detector] foo\n")
    expect(events).toHaveLength(0)
  })

  test("event for a different subscription id is ignored", async () => {
    const events: SubscriptionEvent[] = []
    await act(async () => {
      root.render(
        createElement(HookHost, {
          workspacePath: "/ws/a",
          onEvent: (e) => events.push(e),
        }),
      )
    })
    await flushMicrotasks()
    const line = formatLine("OTHER-ID", { type: "change", timestamp: 9 })
    listenMocks.fire(line)
    expect(events).toHaveLength(0)
  })

  test("unmount calls stop with captured id and detaches listener", async () => {
    await act(async () => {
      root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
    })
    await flushMicrotasks()
    await act(async () => {
      root.unmount()
    })
    await flushMicrotasks()
    expect(rpcMocks.stop).toHaveBeenCalledTimes(1)
    expect(rpcMocks.stop.mock.calls[0]).toEqual(["test-id-1"])
    expect(listenMocks.unlisten).toHaveBeenCalledTimes(1)
  })

  test("StrictMode double-mount: no orphan after final unmount", async () => {
    // Simulate StrictMode: mount -> cleanup -> mount -> cleanup. The
    // start fn returns a fresh id each call so we can verify both lifecycle
    // halves stop their respective ids.
    let counter = 0
    rpcMocks.start.mockImplementation(async () => ({ id: `id-${++counter}` }))

    await act(async () => {
      root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
    })
    await flushMicrotasks()

    // First cleanup + remount (StrictMode pattern): unmount the existing
    // root, create a new one against the same container.
    await act(async () => {
      root.unmount()
    })
    await flushMicrotasks()

    root = createRoot(container)
    await act(async () => {
      root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
    })
    await flushMicrotasks()
    await act(async () => {
      root.unmount()
    })
    await flushMicrotasks()

    expect(rpcMocks.start).toHaveBeenCalledTimes(2)
    expect(rpcMocks.stop).toHaveBeenCalledTimes(2)
    const stoppedIds = rpcMocks.stop.mock.calls.map((c) => c[0]).sort()
    expect(stoppedIds).toEqual(["id-1", "id-2"])
  })

  test("noop when workspacePath is null", async () => {
    await act(async () => {
      root.render(createElement(HookHost, { workspacePath: null }))
    })
    await flushMicrotasks()
    expect(rpcMocks.start).not.toHaveBeenCalled()
    expect(listenMocks.attach).not.toHaveBeenCalled()
  })

  test("noop when not running under Tauri", async () => {
    _setRuntimeCheck(() => false)
    await act(async () => {
      root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
    })
    await flushMicrotasks()
    expect(rpcMocks.start).not.toHaveBeenCalled()
    expect(listenMocks.attach).not.toHaveBeenCalled()
  })

  // bb-hj80: subscription-driven change signal for legacy useEffect+rpc.*
  // consumers (activity-feed, pipeline-flow) that aren't on TanStack Query.
  test("default applyEvent bumps subscription change counter on each change event", async () => {
    expect(_getSubscriptionChangeCount()).toBe(0)
    // Mount with the DEFAULT applyEvent (no onEvent override) so the change
    // counter path runs.
    await act(async () => {
      root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
    })
    await flushMicrotasks()
    listenMocks.fire(formatLine("test-id-1", { type: "change", timestamp: 1 }))
    listenMocks.fire(formatLine("test-id-1", { type: "change", timestamp: 2 }))
    listenMocks.fire(formatLine("test-id-1", { type: "polling_error" }))
    expect(_getSubscriptionChangeCount()).toBe(2)
  })

  test("useSubscriptionChangeSignal returns the live counter and updates on bumps", async () => {
    const observed: number[] = []
    function SignalProbe(): ReactNode {
      const sig = useSubscriptionChangeSignal()
      observed.push(sig)
      return null
    }
    await act(async () => {
      root.render(createElement(SignalProbe))
    })
    await flushMicrotasks()
    expect(observed[observed.length - 1]).toBe(0)

    // Mount the subscription on a separate root so its events can fire while
    // the probe is still mounted.
    const probeContainer = container
    const subRoot = createRoot(document.createElement("div"))
    await act(async () => {
      subRoot.render(createElement(HookHost, { workspacePath: "/ws/a" }))
    })
    await flushMicrotasks()
    await act(async () => {
      listenMocks.fire(formatLine("test-id-1", { type: "change", timestamp: 1 }))
    })
    await flushMicrotasks()

    // Probe should have re-rendered with the new counter value.
    expect(observed[observed.length - 1]).toBe(1)
    void probeContainer

    await act(async () => {
      subRoot.unmount()
    })
    await flushMicrotasks()
  })

  // bb-x878: window.__BEADBOX__.subscription stamp coverage. The stamp is
  // observability-only; tests assert the shape and lifecycle so an
  // operator triaging bb-i4qd-class issues gets a reliable signal.
  describe("window.__BEADBOX__.subscription stamp (bb-x878)", () => {
    function readStamp(): Record<string, unknown> | undefined {
      const beadbox = (globalThis as { window?: { __BEADBOX__?: Record<string, unknown> } }).window
        ?.__BEADBOX__
      return beadbox?.subscription as Record<string, unknown> | undefined
    }

    beforeEach(() => {
      // Clear any leftover stamp from the previous suite case.
      const beadbox = (globalThis as { window?: { __BEADBOX__?: Record<string, unknown> } }).window
        ?.__BEADBOX__
      if (beadbox) delete beadbox.subscription
    })

    test("mount + start success populates activeId, listenerAttached, workspacePath", async () => {
      await act(async () => {
        root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
      })
      await flushMicrotasks()
      const stamp = readStamp()
      expect(stamp).toBeDefined()
      expect(stamp?.activeId).toBe("test-id-1")
      expect(stamp?.listenerAttached).toBe(true)
      expect(stamp?.workspacePath).toBe("/ws/a")
      expect(stamp?.eventCount).toBe(0)
      expect(stamp?.lastEventAt).toBeNull()
      expect(stamp?.lastEventType).toBeNull()
      expect(stamp?.lastInvalidateAt).toBeNull()
    })

    test("change event bumps eventCount, lastEventAt, lastEventType, lastInvalidateAt", async () => {
      await act(async () => {
        root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
      })
      await flushMicrotasks()
      await act(async () => {
        listenMocks.fire(formatLine("test-id-1", { type: "change", timestamp: 99 }))
      })
      await flushMicrotasks()
      const stamp = readStamp()
      expect(stamp?.eventCount).toBe(1)
      expect(stamp?.lastEventType).toBe("change")
      expect(typeof stamp?.lastEventAt).toBe("string")
      expect(typeof stamp?.lastInvalidateAt).toBe("string")
    })

    test("polling_error event bumps eventCount + lastEventType but NOT lastInvalidateAt", async () => {
      await act(async () => {
        root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
      })
      await flushMicrotasks()
      await act(async () => {
        listenMocks.fire(formatLine("test-id-1", { type: "polling_error" }))
      })
      await flushMicrotasks()
      const stamp = readStamp()
      expect(stamp?.eventCount).toBe(1)
      expect(stamp?.lastEventType).toBe("polling_error")
      expect(stamp?.lastInvalidateAt).toBeNull()
    })

    test("unmount clears activeId/listenerAttached/workspacePath but preserves event history", async () => {
      await act(async () => {
        root.render(createElement(HookHost, { workspacePath: "/ws/a" }))
      })
      await flushMicrotasks()
      await act(async () => {
        listenMocks.fire(formatLine("test-id-1", { type: "change", timestamp: 1 }))
      })
      await flushMicrotasks()
      await act(async () => {
        root.unmount()
      })
      await flushMicrotasks()
      const stamp = readStamp()
      expect(stamp?.activeId).toBeNull()
      expect(stamp?.listenerAttached).toBe(false)
      expect(stamp?.workspacePath).toBeNull()
      // Historical record survives teardown for post-mortem.
      expect(stamp?.eventCount).toBe(1)
      expect(stamp?.lastEventType).toBe("change")
    })
  })

  // bb-on9h: telemetry sphere must NOT propagate exceptions into the
  // subscription wire. Per pm/spec.md §5.2 + pm/systemdesign.md §3.1,
  // the kkrpc subscribe.start → onStderr → invalidateQueries lifecycle
  // is the load-bearing path; supplementary posthog.capture calls
  // added by bb-v340 are observability-only. CI surfaced this when
  // posthog.capture was undefined (SDK never init()'d in that fresh
  // process) — every TypeError propagated and killed
  // useChangeSubscription start. safeCapture in subscribe.ts wraps
  // every callsite to ensure the wire wins.
  describe("safeCapture protects the wire from posthog SDK throws (bb-on9h)", () => {
    test("subscription start succeeds when posthog.capture is undefined", async () => {
      const originalCapture = (posthog as { capture?: unknown }).capture
      // Simulate posthog-js's pre-init state where capture is undefined.
      ;(posthog as { capture?: unknown }).capture = undefined
      try {
        await act(async () => {
          root.render(createElement(HookHost, { workspacePath: "/ws/safe-cap" }))
        })
        await flushMicrotasks()
        // The wire MUST work despite the SDK gap: subscribe.start was
        // called, listener attached, no exception propagated to test.
        expect(rpcMocks.start).toHaveBeenCalledTimes(1)
        expect(listenMocks.attach).toHaveBeenCalledTimes(1)
      } finally {
        ;(posthog as { capture?: unknown }).capture = originalCapture
      }
    })

    test("subscription start succeeds when posthog.capture throws", async () => {
      const originalCapture = (posthog as { capture?: unknown }).capture
      ;(posthog as { capture?: unknown }).capture = (() => {
        throw new Error("posthog transport down")
      }) as typeof posthog.capture
      try {
        await act(async () => {
          root.render(createElement(HookHost, { workspacePath: "/ws/safe-cap-2" }))
        })
        await flushMicrotasks()
        expect(rpcMocks.start).toHaveBeenCalledTimes(1)
        expect(listenMocks.attach).toHaveBeenCalledTimes(1)
      } finally {
        ;(posthog as { capture?: unknown }).capture = originalCapture
      }
    })
  })
})
