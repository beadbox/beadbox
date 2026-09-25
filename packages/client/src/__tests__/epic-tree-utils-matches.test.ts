// Note: window/document/navigator/location stubs are wired via
// bunfig.toml's `[test] preload` so posthog-js (eagerly evaluated when
// epic-tree-utils.ts is imported below) doesn't crash at module load.

import { describe, expect, test } from "bun:test"
import { matchesBead } from "../lib/epic-tree-utils"
import type { Bead, Filters } from "../lib/types"

// bb-fe03.7 regression suite for matchesBead. Cyclomatic complexity was 18
// (8 sequential filter checks + a search subcheck). The refactor to a
// predicate-list pattern preserves observable behavior — every truthy/falsy
// outcome below must hold across the refactor.

const baseBead = (over: Partial<Bead> = {}): Bead =>
  ({
    id: "bb-x",
    title: "Hello world",
    status: "open",
    priority: "medium",
    type: "task",
    assignee: "eng2",
    rigName: "blue",
    specId: undefined,
    dueAt: undefined,
    ...over,
  }) as unknown as Bead

const baseFilters = (over: Partial<Filters> = {}): Filters => ({
  // beadbox-brg: status defaults to the full canonical set so beads aren't
  // accidentally filtered out by test fixtures.
  status: [
    "open",
    "in_progress",
    "closed",
    "ready_for_qa",
    "qa_passed",
    "ready_to_ship",
    "blocked",
    "deferred",
  ],
  assignee: "all",
  priority: "all",
  search: "",
  showMessages: false,
  showWaves: false,
  hasSpec: false,
  hasDeadline: false,
  rig: "all",
  grouped: false,
  ...over,
})

describe("matchesBead", () => {
  test("filters custom types by their exact value", () => {
    expect(matchesBead(baseBead({ type: "decision" }), baseFilters({ type: "decision" }))).toBe(
      true,
    )
    expect(matchesBead(baseBead({ type: "task" }), baseFilters({ type: "decision" }))).toBe(false)
  })
  test("returns true with default filters for a normal task bead", () => {
    expect(matchesBead(baseBead(), baseFilters())).toBe(true)
  })

  test("hides 'message' beads when showMessages=false", () => {
    expect(matchesBead(baseBead({ type: "message" } as Partial<Bead>), baseFilters())).toBe(false)
  })

  test("includes 'message' beads when showMessages=true", () => {
    expect(
      matchesBead(
        baseBead({ type: "message" } as Partial<Bead>),
        baseFilters({ showMessages: true }),
      ),
    ).toBe(true)
  })

  test("explicit message type and full system view include messages", () => {
    const message = baseBead({ type: "message" })
    expect(matchesBead(message, baseFilters({ type: "message" }))).toBe(true)
    expect(matchesBead(message, baseFilters({ includeSystem: true }))).toBe(true)
  })

  test("status filter excludes mismatched beads", () => {
    expect(matchesBead(baseBead({ status: "closed" }), baseFilters({ status: ["open"] }))).toBe(
      false,
    )
    expect(matchesBead(baseBead({ status: "open" }), baseFilters({ status: ["open"] }))).toBe(true)
  })

  test("multi-select status filter matches if bead status is in the list (beadbox-brg)", () => {
    const both = baseFilters({ status: ["open", "in_progress"] })
    expect(matchesBead(baseBead({ status: "open" }), both)).toBe(true)
    expect(matchesBead(baseBead({ status: "in_progress" }), both)).toBe(true)
    expect(matchesBead(baseBead({ status: "closed" }), both)).toBe(false)
  })

  test("empty status array = nothing visible (beadbox-brg strict whitelist)", () => {
    const none = baseFilters({ status: [] })
    expect(matchesBead(baseBead({ status: "open" }), none)).toBe(false)
    expect(matchesBead(baseBead({ status: "closed" }), none)).toBe(false)
    expect(matchesBead(baseBead({ status: "in_progress" }), none)).toBe(false)
  })

  test("priority filter excludes mismatched beads", () => {
    expect(matchesBead(baseBead({ priority: "critical" }), baseFilters({ priority: "high" }))).toBe(
      false,
    )
    expect(matchesBead(baseBead({ priority: "high" }), baseFilters({ priority: "high" }))).toBe(
      true,
    )
  })

  test("assignee filter excludes mismatched beads", () => {
    expect(matchesBead(baseBead({ assignee: "eng1" }), baseFilters({ assignee: "eng2" }))).toBe(
      false,
    )
    expect(matchesBead(baseBead({ assignee: "eng2" }), baseFilters({ assignee: "eng2" }))).toBe(
      true,
    )
  })

  test("hasSpec filter requires specId to be set", () => {
    expect(matchesBead(baseBead({ specId: undefined }), baseFilters({ hasSpec: true }))).toBe(false)
    expect(matchesBead(baseBead({ specId: "spec-1" }), baseFilters({ hasSpec: true }))).toBe(true)
  })

  test("hasDeadline filter requires dueAt to be set", () => {
    expect(matchesBead(baseBead({ dueAt: undefined }), baseFilters({ hasDeadline: true }))).toBe(
      false,
    )
    expect(
      matchesBead(baseBead({ dueAt: new Date("2026-01-01") }), baseFilters({ hasDeadline: true })),
    ).toBe(true)
  })

  test("rig filter excludes mismatched beads", () => {
    expect(matchesBead(baseBead({ rigName: "blue" }), baseFilters({ rig: "red" }))).toBe(false)
    expect(matchesBead(baseBead({ rigName: "red" }), baseFilters({ rig: "red" }))).toBe(true)
  })

  test("search matches title (case-insensitive)", () => {
    expect(matchesBead(baseBead({ title: "Hello WORLD" }), baseFilters({ search: "world" }))).toBe(
      true,
    )
    expect(matchesBead(baseBead({ title: "unrelated" }), baseFilters({ search: "world" }))).toBe(
      false,
    )
  })

  test("search matches id (case-insensitive)", () => {
    expect(matchesBead(baseBead({ id: "BB-XYZ" }), baseFilters({ search: "xyz" }))).toBe(true)
    expect(matchesBead(baseBead({ id: "bb-other" }), baseFilters({ search: "xyz" }))).toBe(false)
  })

  test("multiple filters AND together — all must pass", () => {
    expect(
      matchesBead(
        baseBead({ status: "open", priority: "critical" }),
        baseFilters({ status: ["open"], priority: "high" }),
      ),
    ).toBe(false)
    expect(
      matchesBead(
        baseBead({ status: "open", priority: "critical" }),
        baseFilters({ status: ["open"], priority: "critical" }),
      ),
    ).toBe(true)
  })
})
