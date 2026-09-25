// Security unit tests for lib/bd-argv.ts (beadbox-l5i.3, item 3).
//
// Threat: bd is a cobra/pflag CLI. Any user-controlled string that reaches
// argv as its own token and begins with "-" is parsed as a FLAG, not data.
// Verified live against bd 1.0.5 on 2026-08-20:
//
//   $ bd show --db=/tmp/evil          -> honoured the flag; bd pointed at /tmp
//   $ bd show -- --db=/tmp/evil       -> treated as a positional bead ID
//
// So a bead ID of "--db=/somewhere/else" silently redirects a read OR a
// mutation to an attacker-chosen database. Two defences, both tested here:
//
//   1. Positional bead IDs are charset-validated (a real bead ID never
//      starts with "-").
//   2. Option values are emitted as a single "--flag=value" token, so the
//      value can never be re-lexed as a separate flag no matter what it
//      contains.
//
// The "--" terminator is deliberately NOT the general defence: buildArgs()
// appends "--json" AFTER the caller's args on every bdExec path, and a "--"
// would swallow it.

import { describe, expect, test } from "bun:test"

import {
  assertNotFlagLike,
  assertCommentId,
  assertNumericId,
  assertSafeBeadId,
  assertSafeBeadIds,
  BdArgvError,
  flagArg,
} from "../lib/bd-argv"

describe("assertSafeBeadId", () => {
  test("accepts real-world bead ID shapes", () => {
    for (const id of ["bb-x0il", "beadbox-l5i.3", "bd-123", "A1", "tr-9_x"]) {
      expect(assertSafeBeadId(id)).toBe(id)
    }
  })

  test("rejects an ID that would be parsed as bd's --db flag", () => {
    expect(() => assertSafeBeadId("--db=/tmp/evil")).toThrow(BdArgvError)
  })

  test("rejects a single-dash ID", () => {
    expect(() => assertSafeBeadId("-h")).toThrow(BdArgvError)
  })

  test("rejects the flag terminator itself", () => {
    expect(() => assertSafeBeadId("--")).toThrow(BdArgvError)
  })

  test("rejects whitespace, which no bead ID contains", () => {
    expect(() => assertSafeBeadId("bb-1 --db /tmp")).toThrow(BdArgvError)
  })

  test("rejects a NUL byte", () => {
    expect(() => assertSafeBeadId("bb-1\0evil")).toThrow(BdArgvError)
  })

  test("rejects an empty ID", () => {
    expect(() => assertSafeBeadId("")).toThrow(BdArgvError)
  })

  test("rejects a non-string ID", () => {
    expect(() => assertSafeBeadId(undefined as unknown as string)).toThrow(BdArgvError)
  })

  test("names the offending value in the error so the UI can surface it", () => {
    expect(() => assertSafeBeadId("--db=/tmp/evil")).toThrow(/--db=\/tmp\/evil/)
  })
})

describe("assertSafeBeadIds", () => {
  test("returns the list unchanged when every ID is safe", () => {
    expect(assertSafeBeadIds(["bb-1", "bb-2"])).toEqual(["bb-1", "bb-2"])
  })

  test("rejects the whole batch when any single ID is hostile", () => {
    expect(() => assertSafeBeadIds(["bb-1", "--db=/tmp/evil"])).toThrow(BdArgvError)
  })
})

describe("flagArg", () => {
  test("emits a single token so the value cannot be re-lexed as a flag", () => {
    expect(flagArg("--title", "hello")).toBe("--title=hello")
  })

  test("neutralises a title that is itself a bd flag", () => {
    // As two tokens this would have been ["--title", "--db=/tmp/evil"] and bd
    // would have consumed --db. As one token the whole thing is the value.
    expect(flagArg("--title", "--db=/tmp/evil")).toBe("--title=--db=/tmp/evil")
  })

  test("preserves values containing spaces, quotes and newlines verbatim", () => {
    const nasty = `a "b" 'c'\nd; rm -rf /`
    expect(flagArg("--description", nasty)).toBe(`--description=${nasty}`)
  })

  test("preserves an empty value", () => {
    expect(flagArg("--assignee", "")).toBe("--assignee=")
  })

  test("rejects a NUL byte in the value", () => {
    expect(() => flagArg("--title", "a\0b")).toThrow(BdArgvError)
  })

  test("rejects a malformed flag name (developer error, caught at the seam)", () => {
    expect(() => flagArg("title", "x")).toThrow(BdArgvError)
    expect(() => flagArg("--title=", "x")).toThrow(BdArgvError)
  })
})

describe("assertCommentId (beadbox-vav)", () => {
  const ID = "01a0d997-40fa-7a12-807e-c472c48e3efd"

  test("returns a lowercase or uppercase UUID unchanged", () => {
    expect(assertCommentId(ID)).toBe(ID)
    expect(assertCommentId(ID.toUpperCase())).toBe(ID.toUpperCase())
  })

  test("accepts any UUID version (v4 and v7 are both real bd ids)", () => {
    const v4 = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b"
    expect(assertCommentId(v4)).toBe(v4)
  })

  test.each([
    ["OR-injection", "1 OR 1=1"],
    ["quote break after a UUID", `${ID}' OR '1'='1`],
    ["trailing semicolon", `${ID};`],
    ["empty", ""],
    ["37 chars", `${ID}0`],
    ["35 chars", ID.slice(0, -1)],
    ["trailing newline (JS $ is end of input)", `${ID}\n`],
    ["leading space", ` ${ID}`],
    ["non-hex", `${ID.slice(0, -1)}g`],
    ["no hyphens", ID.replaceAll("-", "")],
    ["hyphens moved", "01a0d99740fa-7a12-807e-c472c48e3efd-"],
    ["integer string", "42"],
  ])("refuses %s", (_label, value) => {
    expect(() => assertCommentId(value)).toThrow(BdArgvError)
  })

  test("refuses non-strings", () => {
    expect(() => assertCommentId(42 as unknown as string)).toThrow(BdArgvError)
    expect(() => assertCommentId(null as unknown as string)).toThrow(BdArgvError)
  })
})

describe("assertNumericId", () => {
  test("accepts a positive integer as number or string", () => {
    expect(assertNumericId(42)).toBe("42")
    expect(assertNumericId("42")).toBe("42")
  })

  test("rejects a SQL fragment aimed at the comment-delete query", () => {
    expect(() => assertNumericId("1' OR '1'='1")).toThrow(BdArgvError)
  })

  test("rejects zero, negatives and non-integers", () => {
    expect(() => assertNumericId(0)).toThrow(BdArgvError)
    expect(() => assertNumericId(-1)).toThrow(BdArgvError)
    expect(() => assertNumericId(1.5)).toThrow(BdArgvError)
  })

  test("rejects an empty or whitespace-only id", () => {
    expect(() => assertNumericId("")).toThrow(BdArgvError)
    expect(() => assertNumericId("   ")).toThrow(BdArgvError)
  })
})

describe("assertNotFlagLike", () => {
  // For positional values that are free-form text but must never be lexed as
  // a flag (bd config set <key> <value>).
  test("passes ordinary values through unchanged", () => {
    for (const v of ["needs-review", "in_progress", "Blocked On QA", ""]) {
      expect(assertNotFlagLike(v, "status")).toBe(v)
    }
  })

  test("rejects a value beginning with a dash", () => {
    expect(() => assertNotFlagLike("-h", "status")).toThrow(BdArgvError)
    expect(() => assertNotFlagLike("--db=/tmp/evil", "status")).toThrow(BdArgvError)
  })

  test("names the field in the error", () => {
    expect(() => assertNotFlagLike("-h", "status")).toThrow(/status/)
  })
})
