// SQL-server subscription polls must remain independent of bd CLI execution.
import { describe, expect, test } from "bun:test"
import { POLLED_TABLES, SERVER_POLL_SQL } from "../lib/server-poll-sql"

describe("server poll SQL", () => {
  test("covers all eight user-visible Dolt tables", () => {
    expect(POLLED_TABLES).toEqual([
      "issues", "comments", "labels", "dependencies", "wisps",
      "wisp_comments", "wisp_labels", "wisp_dependencies",
    ])
    for (const table of POLLED_TABLES) {
      expect(SERVER_POLL_SQL).toContain(`DOLT_HASHOF_TABLE('${table}')`)
    }
  })
})
