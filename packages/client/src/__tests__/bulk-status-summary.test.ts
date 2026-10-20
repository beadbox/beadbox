// beadbox-id1 (GH #59): the toast and the selection after a bulk status
// change. All OK: one success line, selection clears. Any failure: "Updated N
// of M; K failed" with one line per failed id, and only the failed ids stay
// selected so a retry is one click.

import { describe, expect, test } from "bun:test"
import { summarizeBulkStatus } from "../lib/bulk-status-summary"

describe("summarizeBulkStatus (beadbox-id1)", () => {
  test("all succeeded: one success line, nothing stays selected", () => {
    const s = summarizeBulkStatus(
      [
        { id: "bb-1", success: true },
        { id: "bb-2", success: true },
      ],
      "In Progress",
    )
    expect(s).toEqual({ ok: true, title: "Updated 2 beads to In Progress", keepSelected: [] })
  })

  test("a single bead reads 'bead'", () => {
    expect(summarizeBulkStatus([{ id: "bb-1", success: true }], "Closed").title).toBe(
      "Updated 1 bead to Closed",
    )
  })

  test("partial failure: counts, per-id detail, failed ids stay selected", () => {
    const s = summarizeBulkStatus(
      [
        { id: "bb-1", success: true },
        { id: "bb-2", success: false, error: "issue not found" },
        { id: "bb-3", success: true },
        { id: "bb-4", success: false },
      ],
      "Blocked",
    )
    expect(s.ok).toBe(false)
    expect(s.title).toBe("Updated 2 of 4; 2 failed")
    expect(s.description).toBe("bb-2: issue not found\nbb-4: unknown error")
    expect(s.keepSelected).toEqual(["bb-2", "bb-4"])
  })
})
