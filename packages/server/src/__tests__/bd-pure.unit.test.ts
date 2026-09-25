// bb-fe03.4: pure-function tests pinning the public behaviour of the
// refactored helpers in lib/bd.ts. These functions used to be inline
// switch / branch logic embedded in larger CCN-19+ functions; the
// refactor extracts them so they're independently testable AND so
// lizard's TS parser sees clean function boundaries (the embedded
// versions confused the parser into summing CCN across adjacent code).

import { describe, expect, it } from "bun:test"
import { durationToISODate, getChangedBeadIds, getDataFingerprint, mapType, parseAvailableTypes } from "../lib/bd"

describe("mapType", () => {
  it("rejects a missing issue type", () => {
    expect(() => mapType(undefined)).toThrow(/without issue_type/)
  })

  it("rejects an empty issue type", () => {
    expect(() => mapType("")).toThrow(/without issue_type/)
    expect(() => mapType("  ")).toThrow(/without issue_type/)
  })

  // The value supplied by bd is data, including its original spelling.
  const knownTypes = [
    "bug",
    "feature",
    "epic",
    "chore",
    "message",
    "gate",
    "merge-request",
    "molecule",
    "agent",
    "role",
    "rig",
    "convoy",
    "event",
    "task",
  ] as const

  for (const t of knownTypes) {
    it(`maps "${t}" to "${t}"`, () => {
      expect(mapType(t)).toBe(t)
    })
  }

  it("retains the exact spelling", () => {
    expect(mapType("BUG")).toBe("BUG")
    expect(mapType("Epic")).toBe("Epic")
    expect(mapType("MERGE-REQUEST")).toBe("MERGE-REQUEST")
  })

  it("preserves custom types", () => {
    expect(mapType("unicorn")).toBe("unicorn")
    expect(mapType("xyz")).toBe("xyz")
  })
})

describe("parseAvailableTypes", () => {
  it("reads core objects and custom strings without duplicates", () => {
    expect(parseAvailableTypes({
      core_types: [{ name: "bug" }, { name: "task" }],
      custom_types: ["task", "convoy", "spec"],
    })).toEqual(["bug", "task", "convoy", "spec"])
  })
})

describe("durationToISODate", () => {
  // Helper: assert the returned ISO string represents `expectedAgoMs` ago,
  // tolerating Date.now() drift between the function call and the assertion.
  function expectAgo(iso: string, expectedAgoMs: number, toleranceMs = 50) {
    const t = new Date(iso).getTime()
    const ago = Date.now() - t
    expect(ago).toBeGreaterThanOrEqual(expectedAgoMs - toleranceMs)
    expect(ago).toBeLessThanOrEqual(expectedAgoMs + toleranceMs)
  }

  it("'30s' subtracts 30 seconds from now", () => {
    expectAgo(durationToISODate("30s"), 30_000)
  })

  it("'2m' subtracts 2 minutes from now", () => {
    expectAgo(durationToISODate("2m"), 2 * 60_000)
  })

  it("'1h' subtracts 1 hour from now", () => {
    expectAgo(durationToISODate("1h"), 60 * 60_000)
  })

  it("'7d' subtracts 7 days from now", () => {
    expectAgo(durationToISODate("7d"), 7 * 86_400_000)
  })

  it("'0s' returns the current moment (zero-offset)", () => {
    expectAgo(durationToISODate("0s"), 0)
  })

  it("invalid format ('abc') falls back to now", () => {
    expectAgo(durationToISODate("abc"), 0)
  })

  it("empty string falls back to now", () => {
    expectAgo(durationToISODate(""), 0)
  })

  it("unknown unit ('5x') falls back to now (no match)", () => {
    expectAgo(durationToISODate("5x"), 0)
  })

  it("returns a valid ISO 8601 string", () => {
    const iso = durationToISODate("10s")
    // Z-suffixed UTC ISO with milliseconds.
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

// bb-gp97 (port of bb-y14e): early-return guard pinning. The previous
// shape ran bdExec(["sql", ...], {}) when options.db was undefined; bd
// then auto-discovered from CWD and could fire "'bd sql' is not yet
// supported in embedded mode" if CWD happened to be an embedded
// workspace. PostHog logged 14 events / 1 user from this on v0.24.1.
//
// These tests pin the new guard. They DO NOT mock execFileAsync because
// the guard short-circuits before any subprocess attempt; the act of
// returning without throwing is the whole contract.
describe("getDataFingerprint (bb-gp97 guard)", () => {
  it("returns '' immediately when options.db is undefined", async () => {
    const result = await getDataFingerprint({})
    expect(result).toBe("")
  })

  it("returns '' immediately when options is omitted entirely", async () => {
    const result = await getDataFingerprint()
    expect(result).toBe("")
  })

  it("returns '' immediately when options.db is explicitly undefined", async () => {
    const result = await getDataFingerprint({ db: undefined })
    expect(result).toBe("")
  })
})

describe("getChangedBeadIds (bb-gp97 guard)", () => {
  it("returns [] immediately when options.db is undefined", async () => {
    const result = await getChangedBeadIds("2026-04-27T00:00:00Z", {})
    expect(result).toEqual([])
  })

  it("returns [] immediately when options is omitted entirely", async () => {
    const result = await getChangedBeadIds("2026-04-27T00:00:00Z")
    expect(result).toEqual([])
  })

  it("returns [] immediately when options.db is explicitly undefined", async () => {
    const result = await getChangedBeadIds("2026-04-27T00:00:00Z", { db: undefined })
    expect(result).toEqual([])
  })
})
