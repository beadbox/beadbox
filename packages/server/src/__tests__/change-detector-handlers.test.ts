// bb-fe03.6 regression suite for change-detector's _handlePollSuccess
// and _handlePollError helpers (extracted from the 82-NLOC anonymous
// setTimeout callback). Locks behavior bit-for-bit because the
// detector is on the hot path — subscription tap fires on every
// workspace event.
//
// We test the helpers directly with a synthetic DetectorState rather
// than spinning up a real poll loop. The helpers are pure mutators of
// the state object plus side-effecting console / process.stderr /
// state.emit calls — easy to assert on with a small mock.

import type { ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import {
  _handlePollError,
  _handlePollSuccess,
  _startServerPollChild,
} from "../lib/change-detector"
import { PortFileMissingError } from "../lib/dolt-pool"
import type { SubscriptionEvent } from "../subscribe-protocol"

interface MutableState {
  mode: "embedded" | "server"
  dbPath: string
  emit: (event: SubscriptionEvent) => void
  fsWatcher: null
  trainWatcher: null
  debounceTimer: null
  pollTimer: null
  pollInFlight: boolean
  lastPollResult: string | null
  lastFingerprint: string | null
  lastNotify: number
  consecutiveErrors: number
  errorBroadcasted: boolean
  currentBackoff: number
  portFileMissing: boolean
  stopped: boolean
  // bb-xe8g: present on the live DetectorState; tests using the in-process
  // poll helpers don't spawn a child, so the slot is always null here.
  pollChild: null
}

function makeState(over: Partial<MutableState> = {}): MutableState & {
  emitted: SubscriptionEvent[]
} {
  const emitted: SubscriptionEvent[] = []
  const state = {
    mode: "server" as const,
    dbPath: "/tmp/test/.beads",
    emit: (event: SubscriptionEvent) => emitted.push(event),
    fsWatcher: null,
    trainWatcher: null,
    debounceTimer: null,
    pollTimer: null,
    pollInFlight: false,
    lastPollResult: null as string | null,
    lastFingerprint: null as string | null,
    lastNotify: 0,
    consecutiveErrors: 0,
    errorBroadcasted: false,
    currentBackoff: 1000,
    portFileMissing: false,
    stopped: false,
    pollChild: null,
    ...over,
  }
  return Object.assign(state, { emitted })
}

describe("_handlePollSuccess", () => {
  test("first call: stores lastPollResult, emits 'change' with prev=null", () => {
    const s = makeState()
    // ih (issues hash) is what hashSummary extracts; rows without it
    // produce next=null but the emit still fires.
    _handlePollSuccess(s, '[{"id":"a","ih":"abc123def","ch":"def456abc"}]')
    expect(s.lastPollResult).toBe('[{"id":"a","ih":"abc123def","ch":"def456abc"}]')
    expect(s.emitted).toHaveLength(1)
    expect(s.emitted[0]?.type).toBe("change")
    if (s.emitted[0]?.type === "change") {
      expect(s.emitted[0].prev).toBeNull()
      expect(s.emitted[0].next).toBe("abc123:def456")
    }
  })

  test("identical result on next call: no emit", () => {
    const s = makeState({ lastPollResult: '[{"id":"a","ih":"abc123","ch":"def456"}]' })
    _handlePollSuccess(s, '[{"id":"a","ih":"abc123","ch":"def456"}]')
    expect(s.emitted).toHaveLength(0)
  })

  test("different result: emits 'change' with non-null prev/next", () => {
    const s = makeState({ lastPollResult: '[{"id":"a","ih":"abc123","ch":"def456"}]' })
    _handlePollSuccess(s, '[{"id":"a","ih":"new789","ch":"new000"}]')
    expect(s.emitted).toHaveLength(1)
    expect(s.emitted[0]?.type).toBe("change")
    if (s.emitted[0]?.type === "change") {
      expect(s.emitted[0].prev).not.toBeNull()
      expect(s.emitted[0].next).not.toBeNull()
    }
  })

  test("clears errorBroadcasted + emits 'recovered' before any change emit", () => {
    const s = makeState({
      errorBroadcasted: true,
      consecutiveErrors: 5,
      lastPollResult: '[{"id":"a","ih":"abc123","ch":"def456"}]',
    })
    _handlePollSuccess(s, '[{"id":"a","ih":"abc123","ch":"def456"}]') // identical → no change emit, only recovered
    expect(s.errorBroadcasted).toBe(false)
    expect(s.consecutiveErrors).toBe(0)
    expect(s.emitted).toHaveLength(1)
    expect(s.emitted[0]?.type).toBe("recovered")
  })

  test("clears portFileMissing flag on success", () => {
    const s = makeState({ portFileMissing: true })
    _handlePollSuccess(s, "[]")
    expect(s.portFileMissing).toBe(false)
  })

  test("resets currentBackoff to baseline on success", () => {
    const s = makeState({ currentBackoff: 30_000 })
    _handlePollSuccess(s, "[]")
    expect(s.currentBackoff).toBeLessThan(30_000)
  })

  test("respects state.stopped: no emit after stop", () => {
    const s = makeState({ stopped: true })
    _handlePollSuccess(s, '[{"id":"a","ih":"abc123","ch":"def456"}]')
    expect(s.emitted).toHaveLength(0)
  })

  test("recovered + change both emit when applicable, in correct order", () => {
    const s = makeState({
      errorBroadcasted: true,
      consecutiveErrors: 3,
      lastPollResult: '[{"id":"a","x":1}]',
    })
    _handlePollSuccess(s, '[{"id":"a","x":2}]')
    expect(s.emitted).toHaveLength(2)
    expect(s.emitted[0]?.type).toBe("recovered")
    expect(s.emitted[1]?.type).toBe("change")
  })
})

describe("_handlePollError", () => {
  test("PortFileMissingError: sets portFileMissing flag (first time only)", () => {
    const s = makeState()
    _handlePollError(s, new PortFileMissingError("/tmp/test/.beads"))
    expect(s.portFileMissing).toBe(true)
    expect(s.consecutiveErrors).toBe(1)
  })

  test("PortFileMissingError: idempotent — second call doesn't double-warn (flag already set)", () => {
    const s = makeState({ portFileMissing: true })
    _handlePollError(s, new PortFileMissingError("/tmp/test/.beads"))
    expect(s.portFileMissing).toBe(true)
    expect(s.consecutiveErrors).toBe(1)
  })

  test("3 consecutive errors → emits polling_error", () => {
    const s = makeState()
    _handlePollError(s, new Error("boom 1"))
    _handlePollError(s, new Error("boom 2"))
    expect(s.emitted).toHaveLength(0) // <3 consecutive, no broadcast yet
    _handlePollError(s, new Error("boom 3"))
    expect(s.emitted).toHaveLength(1)
    expect(s.emitted[0]?.type).toBe("polling_error")
    expect(s.errorBroadcasted).toBe(true)
  })

  test("after broadcast, further errors do NOT re-broadcast polling_error (but DO emit reconnecting)", () => {
    // bb-v340: after polling_error is broadcast, each retry emits a
    // reconnecting event (with attempt_number + backoff_ms) so the renderer
    // can fire ws_reconnecting at parity with v0.24.x. polling_error itself
    // is still gated by errorBroadcasted to avoid spurious re-emission.
    const s = makeState({ consecutiveErrors: 3, errorBroadcasted: true })
    _handlePollError(s, new Error("boom"))
    expect(s.emitted).toHaveLength(1)
    const evt = s.emitted[0]
    expect(evt?.type).toBe("reconnecting")
    if (evt?.type === "reconnecting") {
      expect(evt.attempt_number).toBe(4)
      expect(evt.backoff_ms).toBeGreaterThan(0)
    }
    // polling_error is NOT re-emitted — that's the original contract.
    expect(s.emitted.filter((e) => e.type === "polling_error")).toHaveLength(0)
  })

  test("circuit breaker error: backoff jumps to max immediately", () => {
    const s = makeState({ currentBackoff: 1000 })
    _handlePollError(s, new Error("circuit breaker open"))
    expect(s.currentBackoff).toBeGreaterThan(30_000)
  })

  test("non-circuit-breaker error: backoff doubles", () => {
    const s = makeState({ currentBackoff: 1000 })
    _handlePollError(s, new Error("other failure"))
    expect(s.currentBackoff).toBe(2000)
  })

  test("backoff is capped at max", () => {
    const s = makeState({ currentBackoff: 100_000 })
    _handlePollError(s, new Error("other"))
    expect(s.currentBackoff).toBeLessThanOrEqual(60_000)
  })

  test("stopped state: polling_error broadcast does NOT emit", () => {
    const s = makeState({ consecutiveErrors: 2, stopped: true })
    _handlePollError(s, new Error("boom"))
    // errorBroadcasted should still flip even though emit is suppressed
    expect(s.errorBroadcasted).toBe(true)
    expect(s.emitted).toHaveLength(0)
  })

  test("error stderr field is consumed for classification (combined regex)", () => {
    const s = makeState({ currentBackoff: 1000 })
    const err = Object.assign(new Error("Generic"), { stderr: "circuit breaker tripped" })
    _handlePollError(s, err)
    // stderr contains "circuit breaker" → backoff jumps to max
    expect(s.currentBackoff).toBeGreaterThan(30_000)
  })
})

// bb-xe8g: shell-spawn poll child lifecycle. The child runs `bd sql`
// in a loop and emits [SUBSCRIPTION:<id>] lines to inherited stderr —
// this test only verifies spawn + kill semantics, not poll correctness
// (which depends on a real Dolt server). The dbPath points at /tmp so
// `bd sql` will fail; the script's error path swallows it and retries,
// which is fine for the lifecycle assertion.
// bb-y93v: regression gate — the polled SQL must cover every table whose
// hash flips on a user-visible bd write. If a future refactor drops a
// column, this test fails before users notice the silent UI staleness.
describe("hashSummary tables covered (bb-y93v)", () => {
  test("summary includes label + dependency + wisp_* hashes when present", () => {
    const { hashSummary } = require("../lib/change-detector") as typeof import("../lib/change-detector")
    const fullRow = JSON.stringify([
      {
        ih: "issAAAAAAAA",
        ch: "comBBBBBBBB",
        lh: "labCCCCCCCC",
        dh: "depDDDDDDDD",
        wh: "wspEEEEEEEE",
        wch: "wcoFFFFFFFF",
        wlh: "wlaGGGGGGGG",
        wdh: "wdeHHHHHHHH",
      },
    ])
    const summary = hashSummary(fullRow)
    expect(summary).toBe("issAAA:comBBB:labCCC:depDDD:wspEEE:wcoFFF:wlaGGG:wdeHHH")
  })

  test("backwards-compatible with legacy 2-column poll results", () => {
    const { hashSummary } = require("../lib/change-detector") as typeof import("../lib/change-detector")
    const legacyRow = JSON.stringify([{ ih: "abcdef000", ch: "fedcba111" }])
    expect(hashSummary(legacyRow)).toBe("abcdef:fedcba")
  })
})

describe("_startServerPollChild (bb-xe8g)", () => {
  // Use a dbPath under the OS tmp dir so projectRootFromDb resolves to
  // an existing directory (posix_spawn chdirs there before exec).
  // Cast pollChild slot to ChildProcess|null since MutableState pins it
  // to null structurally; tests need the real type to call .kill().
  type ServerState = Omit<ReturnType<typeof makeState>, "pollChild"> & {
    pollChild: ChildProcess | null
  }
  function makeServerState(): ServerState {
    const s = makeState({ dbPath: `${tmpdir()}/.beads` }) as unknown as ServerState
    return s
  }

  test("populates pollChild on start, child has a pid", () => {
    const s = makeServerState()
    _startServerPollChild(
      s as unknown as Parameters<typeof _startServerPollChild>[0],
      "test-id-xe8g",
    )
    expect(s.pollChild).not.toBeNull()
    expect(typeof s.pollChild?.pid).toBe("number")
    // Cleanup: kill the spawned shell so the test process can exit.
    // stopped first, or the supervisor (beadbox-01f.2) replaces it.
    s.stopped = true
    s.pollChild?.kill("SIGKILL")
  })

  test("child exits on SIGKILL within reasonable time", async () => {
    const s = makeServerState()
    _startServerPollChild(
      s as unknown as Parameters<typeof _startServerPollChild>[0],
      "test-id-xe8g-kill",
    )
    const child = s.pollChild
    if (!child) throw new Error("pollChild not set")
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("exit", (code: number | null) => resolve(code))
    })
    // SIGKILL is the guaranteed-exit signal; the production stop()
    // tries SIGTERM first then escalates to SIGKILL after 250ms.
    s.stopped = true
    child.kill("SIGKILL")
    await exitPromise
    expect(child.killed).toBe(true)
  }, 5_000)
})
