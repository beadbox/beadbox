// beadbox-brg: getFiltersPreference must migrate the old singleton-string
// status shape ('all' / 'open' / etc.) to the new BeadStatus[] shape on
// read so existing users don't lose state when this lands.
//
// beadbox-6d9: defensive happy-dom registration so the file works whether
// or not bunfig's _test-globals.ts preload fired (qa2 hit "localStorage
// is not defined" running the file directly without the preload). The
// register call is a no-op if a document already exists, matching
// _test-globals.ts's gating pattern.

import { GlobalRegistrator } from "@happy-dom/global-registrator"

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register()
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getFiltersPreference } from "../lib/local-storage"

const FILTERS_KEY = "beads-filters"

beforeEach(() => {
  try {
    localStorage.removeItem(FILTERS_KEY)
  } catch {
    /* tolerable */
  }
})

afterEach(() => {
  try {
    localStorage.removeItem(FILTERS_KEY)
  } catch {
    /* tolerable */
  }
})

describe("getFiltersPreference migration (beadbox-brg)", () => {
  const DEFAULT_STATUSES = [
    "open",
    "in_progress",
    "closed",
    "ready_for_qa",
    "qa_passed",
    "ready_to_ship",
    "blocked",
    "deferred",
  ]

  test("no stored value → defaults (canonical status set checked, grouped=false)", () => {
    const f = getFiltersPreference()
    expect(Array.isArray(f.status)).toBe(true)
    expect(f.status).toEqual(DEFAULT_STATUSES)
    expect(f.grouped).toBe(false)
  })

  test("legacy status='all' → canonical default set (user keeps seeing everything)", () => {
    localStorage.setItem(
      FILTERS_KEY,
      JSON.stringify({
        status: "all",
        assignee: "all",
        priority: "all",
        search: "",
        showMessages: false,
        showWaves: false,
        hasSpec: false,
        hasDeadline: false,
        rig: "all",
      }),
    )
    expect(getFiltersPreference().status).toEqual(DEFAULT_STATUSES)
  })

  test("legacy status='open' → ['open']", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: "open" }))
    expect(getFiltersPreference().status).toEqual(["open"])
  })

  test("new shape status=['open','closed'] passes through", () => {
    localStorage.setItem(
      FILTERS_KEY,
      JSON.stringify({ status: ["open", "closed"], grouped: true }),
    )
    const f = getFiltersPreference()
    expect(f.status).toEqual(["open", "closed"])
    expect(f.grouped).toBe(true)
  })

  test("malformed status (object / null) → canonical default set", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: null }))
    expect(getFiltersPreference().status).toEqual(DEFAULT_STATUSES)
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: { not: "an array" } }))
    expect(getFiltersPreference().status).toEqual(DEFAULT_STATUSES)
  })

  test("merges with defaults so new fields like 'grouped' get filled", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: ["open"] }))
    const f = getFiltersPreference()
    expect(f.grouped).toBe(false)
    expect(f.priority).toEqual([])
    expect(f.assignee).toBe("all")
  })
})

// beadbox-813: priority went from a single value ('all' | 'high' | ...) to a
// multi-select array, where empty means "All Priority". A stored single value
// must load as the same view: 'all' as [], one priority as a one-item list.
describe("getFiltersPreference priority migration (beadbox-813)", () => {
  test("no stored value → [] (All Priority)", () => {
    expect(getFiltersPreference().priority).toEqual([])
  })

  test("legacy priority='all' → [] (the user keeps seeing every priority)", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: ["open"], priority: "all" }))
    expect(getFiltersPreference().priority).toEqual([])
  })

  test("legacy single priority='high' → ['high']", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: ["open"], priority: "high" }))
    expect(getFiltersPreference().priority).toEqual(["high"])
  })

  test("new shape round-trips", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: ["open"], priority: ["critical", "high"] }))
    expect(getFiltersPreference().priority).toEqual(["critical", "high"])
  })

  test("unknown entries are dropped; malformed values → []", () => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ priority: ["high", "urgent", 3] }))
    expect(getFiltersPreference().priority).toEqual(["high"])
    for (const bad of [null, { not: "a list" }, "urgent", 7]) {
      localStorage.setItem(FILTERS_KEY, JSON.stringify({ priority: bad }))
      expect(getFiltersPreference().priority).toEqual([])
    }
  })
})
