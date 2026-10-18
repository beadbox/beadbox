// beadbox-429: the status.custom parser (name[:category]) and the Settings
// write-back that keeps each configured entry's token.

import { describe, expect, test } from "bun:test"

import { parseStatusCatalog } from "../lib/bd"
import { parseStatusConfig, tokensForNames } from "../lib/status-config"

const names = (raw: string) => parseStatusConfig(raw).map((e) => e.name)

describe("parseStatusConfig", () => {
  test("plain comma form", () => {
    expect(parseStatusConfig("ready_for_qa,qa_passed")).toEqual([
      { name: "ready_for_qa", token: "ready_for_qa" },
      { name: "qa_passed", token: "qa_passed" },
    ])
  })

  test("name:category form: the name is the status, the category is kept", () => {
    expect(parseStatusConfig("ticket_awaiting:active,ticket_active:wip,unit_escalated:frozen")).toEqual([
      { name: "ticket_awaiting", category: "active", token: "ticket_awaiting:active" },
      { name: "ticket_active", category: "wip", token: "ticket_active:wip" },
      { name: "unit_escalated", category: "frozen", token: "unit_escalated:frozen" },
    ])
  })

  test("mixed forms, surrounding whitespace and blank entries", () => {
    expect(names(" review , ,qa:done,, ship ")).toEqual(["review", "qa", "ship"])
    expect(parseStatusConfig("review, qa:done")[1]).toEqual({ name: "qa", category: "done", token: "qa:done" })
  })

  test("unset or empty is no statuses", () => {
    expect(parseStatusConfig("")).toEqual([])
    expect(parseStatusConfig("  \n")).toEqual([])
    expect(parseStatusConfig("status.custom (not set)")).toEqual([])
  })

  test("an entry with no name is dropped, never offered as a status", () => {
    expect(names(":wip,review")).toEqual(["review"])
  })
})

describe("tokensForNames", () => {
  const current = parseStatusConfig("ticket_awaiting:active,ticket_active:wip,unit_escalated:frozen")

  test("reorder keeps each entry's suffix", () => {
    expect(tokensForNames(["unit_escalated", "ticket_awaiting", "ticket_active"], current)).toEqual([
      "unit_escalated:frozen",
      "ticket_awaiting:active",
      "ticket_active:wip",
    ])
  })

  test("remove keeps the survivors' suffixes; an added name is written bare", () => {
    expect(tokensForNames(["ticket_active", "in_review"], current)).toEqual(["ticket_active:wip", "in_review"])
  })

  test("plain entries round-trip unchanged", () => {
    expect(tokensForNames(["qa", "review"], parseStatusConfig("review,qa"))).toEqual(["qa", "review"])
  })
})

describe("parseStatusCatalog (bd statuses --json)", () => {
  test("names of the built-in and custom statuses", () => {
    expect(
      parseStatusCatalog({
        built_in_statuses: [{ name: "open" }, { name: "blocked" }, { name: "pinned" }],
        custom_statuses: [{ name: "ticket_active" }],
      }),
    ).toEqual({ builtIn: ["open", "blocked", "pinned"], custom: ["ticket_active"] })
  })

  test("output with no built-ins is refused, so the caller falls back to the config", () => {
    expect(() => parseStatusCatalog({})).toThrow()
    expect(() => parseStatusCatalog({ built_in_statuses: "open" } as never)).toThrow()
  })
})
