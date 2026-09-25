// Call-site enforcement tests for the bd argv guards (beadbox-l5i.3, item 3).
//
// bd-argv.security.test.ts proves the guards are correct in isolation. This
// file pins specific builder semantics and sec's reported shape (beadbox-c29).
// Coverage of EVERY exported lib/bd.ts function is mechanical and lives in
// bd-exports-argv.security.test.ts; every spawn outside lib/bd.ts is in the
// census in bd-spawn-census.security.test.ts. A hand-written list of
// functions here would pass vacuously for any function it forgot to name,
// which is how beadbox-c29's six sites went uncaught.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetBdPathCache,
  cookFormula,
  deleteComment,
  pourMolecule,
  setCustomStatuses,
  showFormula,
} from "../lib/bd"
import { BdArgvError, buildCommentArgs, buildUpdateArgs } from "../lib/bd-argv"

const HOSTILE_ID = "--db=/tmp/evil"

describe("buildUpdateArgs", () => {
  test("emits the option as a single token", () => {
    expect(buildUpdateArgs("bb-1", "--title", "hello")).toEqual(["update", "bb-1", "--title=hello"])
  })

  test("keeps a flag-shaped title inside the value token", () => {
    expect(buildUpdateArgs("bb-1", "--title", HOSTILE_ID)).toEqual([
      "update",
      "bb-1",
      `--title=${HOSTILE_ID}`,
    ])
  })

  test("rejects a flag-shaped bead ID", () => {
    expect(() => buildUpdateArgs(HOSTILE_ID, "--title", "x")).toThrow(BdArgvError)
  })

  // bd reads `--description=-` from stdin; spawned bd inherits an open pipe, so
  // the call holds the workspace's db lock until the exec timeout (beadbox-01f.10).
  test("rejects a description of exactly '-'", () => {
    expect(() => buildUpdateArgs("bb-1", "--description", "-")).toThrow(BdArgvError)
  })

  test("accepts '-' wherever bd stores it literally", () => {
    for (const flag of ["--notes", "--acceptance", "--design", "--title"]) {
      expect(buildUpdateArgs("bb-1", flag, "-")).toEqual(["update", "bb-1", `${flag}=-`])
    }
    for (const value of [" -", "- ", "-\n", "--", "-h"]) {
      expect(buildUpdateArgs("bb-1", "--description", value)).toEqual([
        "update",
        "bb-1",
        `--description=${value}`,
      ])
    }
  })
})

describe("buildCommentArgs", () => {
  test("puts a flag terminator ahead of the free-text body", () => {
    // Comment text is a variadic positional (bd comment <id> [text...]), so
    // unlike an option value it cannot use the --flag=value trick. bdExecRaw
    // appends nothing after the caller's args, so "--" is safe here.
    expect(buildCommentArgs("bb-1", "hello")).toEqual(["comment", "bb-1", "--", "hello"])
  })

  test("neutralises comment text that begins with a dash", () => {
    expect(buildCommentArgs("bb-1", "--db=/tmp/evil")).toEqual([
      "comment",
      "bb-1",
      "--",
      "--db=/tmp/evil",
    ])
  })

  test("rejects a flag-shaped bead ID", () => {
    expect(() => buildCommentArgs(HOSTILE_ID, "text")).toThrow(BdArgvError)
  })
})

describe("formula names (beadbox-c29): refuse what bd would lex as a flag, pass everything else", () => {
  const originalBdPath = process.env.BD_PATH
  let root: string
  let db: string
  let log: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "beadbox-c29-shape-"))
    db = join(root, ".beads")
    await mkdir(db)
    log = join(root, "argv.log")
    const fakeBd = join(root, "bd")
    // One record per invocation; tokens separated by \037 so names with
    // spaces keep their boundaries.
    await writeFile(
      fakeBd,
      `#!/bin/sh\nprintf '%s\\037' "$@" >> "${log}"\nprintf '\\036' >> "${log}"\necho '{}'\n`,
      { mode: 0o700 },
    )
    process.env.BD_PATH = fakeBd
    __resetBdPathCache()
  })

  afterEach(async () => {
    if (originalBdPath === undefined) delete process.env.BD_PATH
    else process.env.BD_PATH = originalBdPath
    __resetBdPathCache()
    await rm(root, { recursive: true, force: true })
  })

  async function spawned(): Promise<string[][]> {
    const raw = await readFile(log, "utf-8").catch(() => "")
    return raw
      .split("\x1e")
      .filter(Boolean)
      .map((rec) => rec.split("\x1f").slice(0, -1))
  }

  test("showFormula('--db=/tmp/evil') throws before bd is spawned (sec's reported shape)", async () => {
    await expect(showFormula(HOSTILE_ID, { db })).rejects.toThrow(BdArgvError)
    // The observable that matters: bd never saw the hostile token at all.
    expect(await spawned()).toEqual([])
  })

  // Names users write as filenames and bd accepts (qa2 on beadbox-c29). They
  // worked in v0.26.2; execFile has no shell, so none of these characters
  // means anything to anything but bd.
  const ACCEPTED = [
    "_leading",
    ".dotleading",
    "plus+name",
    "at@name",
    "café",
    "a".repeat(129),
    "sp ace",
  ]

  for (const name of ACCEPTED) {
    const label = name.length > 20 ? `${name.length} x 'a'` : name
    test(`'${label}' reaches bd intact as its own argument (show, cook, pour)`, async () => {
      await showFormula(name, { db })
      await cookFormula(name, { component: "x" }, { db }).catch(() => {})
      await pourMolecule(name, { component: "x" }, "qa tester", { db })
      const [show, cook, pour] = await spawned()
      expect(show.slice(show.indexOf("formula"), show.indexOf("formula") + 3)).toEqual([
        "formula",
        "show",
        name,
      ])
      expect(cook[cook.indexOf("cook") + 1]).toBe(name)
      expect(pour.slice(pour.indexOf("mol"), pour.indexOf("mol") + 3)).toEqual([
        "mol",
        "pour",
        name,
      ])
      expect(pour).toContain("--var=component=x")
      expect(pour).toContain("--assignee=qa tester")
    })
  }

  const REFUSED: Array<[string, string]> = [
    ["a leading '-'", "-dash"],
    ["a flag with a value", HOSTILE_ID],
    ["empty", ""],
    ["a NUL byte", "name\0x"],
    ["longer than the bound", "a".repeat(4097)],
  ]

  for (const [label, name] of REFUSED) {
    test(`${label} is refused before bd is spawned (show, cook, pour)`, async () => {
      await expect(showFormula(name, { db })).rejects.toThrow(BdArgvError)
      await expect(cookFormula(name, undefined, { db })).rejects.toThrow(BdArgvError)
      await expect(pourMolecule(name, {}, undefined, { db })).rejects.toThrow(BdArgvError)
      expect(await spawned()).toEqual([])
    })
  }

  test("a variable name with '=' or a leading '-' is refused; café is fine", async () => {
    // bd splits --var at the FIRST '=', so a key containing '=' could never be
    // set from the CLI; refusing it prevents a silent mis-assignment.
    await expect(cookFormula("f", { "a=b": "c" }, { db })).rejects.toThrow(BdArgvError)
    await expect(cookFormula("f", { "--db": "x" }, { db })).rejects.toThrow(BdArgvError)
    expect(await spawned()).toEqual([])
    await cookFormula("f", { café: "x=y" }, { db }).catch(() => {})
    expect((await spawned())[0]).toContain("--var=café=x=y")
  })
})

describe("deleteComment (beadbox-vav): UUID comment ids, refused before bd runs otherwise", () => {
  // bd >= 1.1.0 stores comments.id as CHAR(36) UUIDs (migration 0037 converts
  // older integer ids), so a real id looks like this one, taken from bd 1.1.0.
  const REAL_ID = "01a0d997-40fa-7a12-807e-c472c48e3efd"
  const originalBdPath = process.env.BD_PATH
  let root: string
  let db: string
  let log: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "beadbox-vav-"))
    db = join(root, ".beads")
    await mkdir(db)
    // Server mode, so a valid id gets past the embedded-mode refusal and
    // actually reaches bd: the accepted case must be observed, not assumed.
    await writeFile(join(db, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))
    log = join(root, "argv.log")
    const fakeBd = join(root, "bd")
    await writeFile(
      fakeBd,
      `#!/bin/sh\nprintf '%s\\037' "$@" >> "${log}"\nprintf '\\036' >> "${log}"\necho '{}'\n`,
      { mode: 0o700 },
    )
    process.env.BD_PATH = fakeBd
    __resetBdPathCache()
  })

  afterEach(async () => {
    if (originalBdPath === undefined) delete process.env.BD_PATH
    else process.env.BD_PATH = originalBdPath
    __resetBdPathCache()
    await rm(root, { recursive: true, force: true })
  })

  async function spawned(): Promise<string[][]> {
    const raw = await readFile(log, "utf-8").catch(() => "")
    return raw
      .split("\x1e")
      .filter(Boolean)
      .map((rec) => rec.split("\x1f").slice(0, -1))
  }

  test("deletes a real UUID comment with the id quoted as a string literal", async () => {
    await expect(deleteComment(REAL_ID, { db })).resolves.toBeUndefined()
    const calls = await spawned()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("sql")
    expect(calls[0]).toContain(`DELETE FROM comments WHERE id = '${REAL_ID}'`)
  })

  test("accepts an uppercase UUID unchanged (the guard is no stricter than the threat)", async () => {
    const upper = REAL_ID.toUpperCase()
    await expect(deleteComment(upper, { db })).resolves.toBeUndefined()
    expect((await spawned())[0]).toContain(`DELETE FROM comments WHERE id = '${upper}'`)
  })

  const REFUSED: [string, unknown][] = [
    ["an OR-injection", "1 OR 1=1"],
    ["a UUID followed by a quote-breaking OR", `${REAL_ID}' OR '1'='1`],
    ["a UUID with a trailing semicolon", `${REAL_ID};`],
    ["an empty string", ""],
    ["a 37-char near-UUID", `${REAL_ID}0`],
    ["a UUID with a trailing newline", `${REAL_ID}\n`],
    ["a UUID with surrounding spaces", ` ${REAL_ID} `],
    ["a UUID with a non-hex character", `${REAL_ID.slice(0, -1)}g`],
    ["a UUID missing its hyphens", REAL_ID.replaceAll("-", "")],
    ["a pre-1.1.0 integer id", "42"],
    ["a number", 42],
  ]
  for (const [label, id] of REFUSED) {
    test(`refuses ${label} before bd is spawned`, async () => {
      await expect(deleteComment(id as string, { db })).rejects.toThrow(BdArgvError)
      expect(await spawned()).toEqual([])
    })
  }
})

describe("setCustomStatuses", () => {
  // `bd config set status.custom <value>` takes the value as a positional, so
  // neither the --flag=value form nor a "--" terminator applies; the status
  // labels themselves have to be rejected when they look like flags.
  test("rejects a status label that would be parsed as a bd flag", async () => {
    await expect(setCustomStatuses(["open", "--db=/tmp/evil"])).rejects.toThrow(BdArgvError)
  })

  test("rejects a single-dash status label", async () => {
    await expect(setCustomStatuses(["-h"])).rejects.toThrow(BdArgvError)
  })
})
