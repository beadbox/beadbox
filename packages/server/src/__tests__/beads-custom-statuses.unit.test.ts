// Tests for handlers/beads.ts — custom status surface (bb-wxuw port from
// 1386b41). Translated from vitest+module-mock to bun:test+bd-fixture so the
// test exercises the real bd CLI path end-to-end. Validation behavior is
// covered structurally; bd state assertions verify round-trip persistence.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"

import * as beads from "../handlers/beads"
import { BD_WORKSPACE_TIMEOUT_MS, createBdWorkspace, type Workspace } from "./fixtures/bd-workspace"

setDefaultTimeout(BD_WORKSPACE_TIMEOUT_MS)

let ws: Workspace

beforeAll(async () => {
  ws = await createBdWorkspace()
})

afterAll(async () => {
  await ws?.cleanup()
})

describe("handlers/beads custom statuses", () => {
  test("getCustomStatusList returns [] when no custom statuses configured", async () => {
    const result = await beads.getCustomStatusList(ws.dbPath)
    expect(result).toEqual([])
  })

  test("updateCustomStatuses persists a valid list and round-trips via bd config", async () => {
    const r = await beads.updateCustomStatuses(["ready_for_qa", "in_review"], ws.dbPath)
    expect(r.success).toBe(true)
    const list = await beads.getCustomStatusList(ws.dbPath)
    expect(list).toEqual(["ready_for_qa", "in_review"])
  })

  test("getAvailableStatuses returns core + custom after persistence", async () => {
    // depends on the previous test's persistence
    const all = await beads.getAvailableStatuses(ws.dbPath)
    expect(all).toContain("open")
    expect(all).toContain("in_progress")
    expect(all).toContain("closed")
    expect(all).toContain("ready_for_qa")
    expect(all).toContain("in_review")
  })

  test("updateCustomStatuses with empty list unsets the bd config key", async () => {
    const r = await beads.updateCustomStatuses([], ws.dbPath)
    expect(r.success).toBe(true)
    const list = await beads.getCustomStatusList(ws.dbPath)
    expect(list).toEqual([])
  })

  test("updateCustomStatuses trims and filters empty entries before persisting", async () => {
    const r = await beads.updateCustomStatuses(["  ready_for_qa  ", "", "  "], ws.dbPath)
    expect(r.success).toBe(true)
    const list = await beads.getCustomStatusList(ws.dbPath)
    expect(list).toEqual(["ready_for_qa"])
  })

  test("rejects a reserved status name without writing", async () => {
    // Pre-clean so we have a known baseline
    await beads.updateCustomStatuses([], ws.dbPath)
    const r = await beads.updateCustomStatuses(["open", "ready_for_qa"], ws.dbPath)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/built-in/)
    const list = await beads.getCustomStatusList(ws.dbPath)
    expect(list).toEqual([])
  })

  test("rejects an invalid name (uppercase/special chars) without writing", async () => {
    await beads.updateCustomStatuses([], ws.dbPath)
    const r = await beads.updateCustomStatuses(["Ready For QA"], ws.dbPath)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/lowercase/)
    const list = await beads.getCustomStatusList(ws.dbPath)
    expect(list).toEqual([])
  })

  test("rejects duplicate names without writing", async () => {
    await beads.updateCustomStatuses([], ws.dbPath)
    const r = await beads.updateCustomStatuses(["ready_for_qa", "ready_for_qa"], ws.dbPath)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Duplicate/)
    const list = await beads.getCustomStatusList(ws.dbPath)
    expect(list).toEqual([])
  })
})
