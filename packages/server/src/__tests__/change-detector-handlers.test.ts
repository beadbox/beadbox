import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { _startServerPollWorker, hashSummary } from "../lib/change-detector"
import { createPollEvents } from "../lib/server-poll-events"
import type { SubscriptionEvent } from "../subscribe-protocol"

describe("SQL poll event semantics", () => {
  test("first successful poll establishes a baseline without an event", () => {
    const events = createPollEvents()
    expect(events.success('[{"ih":"a"}]')).toEqual([])
    expect(events.success('[{"ih":"a"}]')).toEqual([])
    expect(events.success('[{"ih":"b"}]')[0]?.type).toBe("change")
  })

  test("three failures broadcast once, later retries reconnect, recovery precedes change", () => {
    const events = createPollEvents()
    events.success('[{"ih":"a"}]')
    expect(events.failure(5000)).toEqual([])
    expect(events.failure(5000)).toEqual([])
    expect(events.failure(5000)).toEqual([{ type: "polling_error" }])
    expect(events.failure(5000)).toEqual([
      { type: "reconnecting", attempt_number: 4, backoff_ms: 5000 },
    ])
    expect(events.success('[{"ih":"b"}').map((event) => event.type)).toEqual([
      "recovered", "change",
    ])
    expect(events.failure(5000)).toEqual([])
  })

  test("short failure streak recovers silently", () => {
    const events = createPollEvents()
    events.failure(5000)
    expect(events.success("[]")).toEqual([])
  })
})

describe("hashSummary", () => {
  test("summarizes all eight table hashes", () => {
    expect(hashSummary(JSON.stringify([{
      ih: "issAAAAAAAA", ch: "comBBBBBBBB", lh: "labCCCCCCCC", dh: "depDDDDDDDD",
      wh: "wspEEEEEEEE", wch: "wcoFFFFFFFF", wlh: "wlaGGGGGGGG", wdh: "wdeHHHHHHHH",
    }]))).toBe("issAAA:comBBB:labCCC:depDDD:wspEEE:wcoFFF:wlaGGG:wdeHHH")
  })
})

describe("SQL poll worker lifecycle", () => {
  test("starts an independent worker and terminates it", async () => {
    const state = {
      dbPath: `${tmpdir()}/.beads`,
      stopped: false,
      pollWorker: null as Worker | null,
      emit: (_event: SubscriptionEvent) => {},
    }
    _startServerPollWorker(state as Parameters<typeof _startServerPollWorker>[0], "test-sql-worker")
    const worker = state.pollWorker
    expect(worker).not.toBeNull()
    expect(worker).toBeInstanceOf(Worker)
    await worker?.terminate()
  }, 5_000)
})
