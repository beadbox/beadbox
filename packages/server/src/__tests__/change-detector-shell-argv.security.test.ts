// Argv/PATH hygiene for the change-detector's shell poll child
// (beadbox-l5i.3, item 3).
//
// The subscription poller runs an inline POSIX loop under /bin/sh. Two
// properties have to hold:
//
//   1. The workspace path (attacker-influenceable, it comes from whatever
//      workspace the user added) must reach bd as a QUOTED POSITIONAL, never
//      spliced into the script body.
//   2. bd must be invoked by ABSOLUTE PATH. lib/exec.ts appends
//      /usr/local/bin, ~/.local/bin and friends to process.env.PATH, which the
//      child inherits — resolving a bare `bd` through that list is a different
//      (and weaker) trust decision than the resolveBdPath() every other call
//      site makes.

import { describe, expect, test } from "bun:test"

import { buildPollShellArgs } from "../lib/change-detector"

const BD = "/opt/homebrew/bin/bd"

describe("buildPollShellArgs", () => {
  test("passes the db path as a positional, not spliced into the script", () => {
    const args = buildPollShellArgs("sub-1", "/tmp/ws/.beads", BD)
    const script = args[1]
    expect(args[0]).toBe("-c")
    expect(script).not.toContain("/tmp/ws/.beads")
    // The 5th positional is the per-poll bound in whole seconds (beadbox-01f.2),
    // derived in code, never from input. The 6th is the sidecar log path the
    // loop appends its lines to (beadbox-01f.4); empty when there is no log.
    expect(args.slice(2)).toEqual(["--", "sub-1", "/tmp/ws/.beads", BD, "10", ""])
  })

  test("the log path is a positional read through a quoted variable, never spliced", () => {
    const hostile = "/tmp/log; rm -rf ~ $(touch /tmp/pwned) `id`.log"
    const args = buildPollShellArgs("sub-1", "/tmp/ws/.beads", BD, 10, hostile)
    const script = args[1]
    expect(args[7]).toBe(hostile)
    expect(script).not.toContain(hostile)
    expect(script).toContain('LOG="$5"')
    // Every use of the log path is the quoted variable.
    const uses = script.match(/\$LOG\b|"\$LOG"/g) ?? []
    expect(uses.length).toBeGreaterThan(0)
    expect(script).not.toMatch(/[^"]\$LOG[^"]/)
  })

  test("the poll bound is a positive integer however it is passed", () => {
    for (const t of [10, 2.7, 0, -5]) {
      expect(buildPollShellArgs("sub-1", "/tmp/ws/.beads", BD, t)[6]).toMatch(/^[1-9][0-9]*$/)
    }
  })

  test("dereferences the db path through a quoted shell variable", () => {
    const script = buildPollShellArgs("sub-1", "/tmp/ws/.beads", BD)[1]
    expect(script).toContain('--db "$DBPATH"')
  })

  test("invokes bd by absolute path from a positional, never bare", () => {
    const script = buildPollShellArgs("sub-1", "/tmp/ws/.beads", BD)[1]
    // The resolved binary arrives as a positional and is dereferenced quoted.
    expect(script).toContain('"$BD" sql')
    // No bare `bd ` command left for PATH to resolve.
    expect(script).not.toMatch(/(^|[^"$\w])bd sql/m)
  })

  test("does not splice the subscription id into the script body", () => {
    const script = buildPollShellArgs("weird'id", "/tmp/ws/.beads", BD)[1]
    expect(script).not.toContain("weird'id")
  })
})
