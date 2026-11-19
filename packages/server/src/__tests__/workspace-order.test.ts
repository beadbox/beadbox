// beadbox-984: merging a requested sidebar order with the registry's entries.
// The request comes from the client and may be stale (a workspace added or
// removed on another surface since it rendered), so: requested ids that exist
// come first in the requested order, every unnamed entry follows in its
// current relative order, and unknown or repeated ids are ignored.

import { describe, expect, test } from "bun:test"
import { applyWorkspaceOrder } from "../lib/workspace-order"

const ws = (...ids: string[]) => ids.map((id) => ({ id, name: `ws-${id}` }))
const ids = (entries: { id: string }[]) => entries.map((e) => e.id)

describe("applyWorkspaceOrder", () => {
  test("applies the requested order", () => {
    expect(ids(applyWorkspaceOrder(ws("a", "b", "c", "d", "e"), ["e", "a", "b", "c", "d"]))).toEqual([
      "e",
      "a",
      "b",
      "c",
      "d",
    ])
  })

  test("an entry the request does not name (added since) goes to the end", () => {
    expect(ids(applyWorkspaceOrder(ws("a", "b", "c", "new"), ["c", "a", "b"]))).toEqual([
      "c",
      "a",
      "b",
      "new",
    ])
  })

  test("several unnamed entries keep their relative order at the end", () => {
    expect(ids(applyWorkspaceOrder(ws("x", "a", "y", "b", "z"), ["b", "a"]))).toEqual([
      "b",
      "a",
      "x",
      "y",
      "z",
    ])
  })

  test("a requested id that no longer exists (removed since) is ignored", () => {
    expect(ids(applyWorkspaceOrder(ws("a", "c"), ["c", "gone", "a"]))).toEqual(["c", "a"])
  })

  test("a repeated id takes its first position", () => {
    expect(ids(applyWorkspaceOrder(ws("a", "b", "c"), ["b", "a", "b", "c"]))).toEqual(["b", "a", "c"])
  })

  test("an empty request keeps the current order", () => {
    expect(ids(applyWorkspaceOrder(ws("a", "b", "c"), []))).toEqual(["a", "b", "c"])
  })

  test("returns the same entry objects, and does not mutate its input", () => {
    const entries = ws("a", "b")
    const out = applyWorkspaceOrder(entries, ["b", "a"])
    expect(out[0]).toBe(entries[1])
    expect(ids(entries)).toEqual(["a", "b"])
  })
})
