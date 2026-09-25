// Call-site enforcement tests for the bd argv guards (beadbox-l5i.3, item 3).
//
// bd-argv.security.test.ts proves the guards are correct in isolation. This
// file pins specific builder semantics and sec's reported shape (beadbox-c29).
// Coverage of EVERY exported lib/bd.ts function is mechanical and lives in
// bd-exports-argv.security.test.ts; every spawn outside lib/bd.ts is in the
// census in bd-spawn-census.security.test.ts. A hand-written list of
// functions here would pass vacuously for any function it forgot to name,
// which is how beadbox-c29's six sites went uncaught.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBdPathCache, deleteComment, setCustomStatuses, showFormula } from "../lib/bd"
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

describe("sec's reported shape (beadbox-c29): a formula name cannot retarget --db", () => {
  const originalBdPath = process.env.BD_PATH
  let root: string | undefined

  afterEach(async () => {
    if (originalBdPath === undefined) delete process.env.BD_PATH
    else process.env.BD_PATH = originalBdPath
    __resetBdPathCache()
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  test("showFormula('--db=/tmp/evil') throws before bd is spawned", async () => {
    root = await mkdtemp(join(tmpdir(), "beadbox-c29-shape-"))
    const db = join(root, ".beads")
    await mkdir(db)
    const log = join(root, "argv.log")
    const fakeBd = join(root, "bd")
    await writeFile(fakeBd, `#!/bin/sh\necho "$*" >> "${log}"\necho '{}'\n`, { mode: 0o700 })
    process.env.BD_PATH = fakeBd
    __resetBdPathCache()

    await expect(showFormula(HOSTILE_ID, { db })).rejects.toThrow(BdArgvError)
    // The observable that matters: bd never saw the hostile token at all.
    expect(await readFile(log, "utf-8").catch(() => "")).toBe("")
  })
})

describe("deleteComment", () => {
  test("rejects a non-numeric comment ID before it reaches the SQL string", async () => {
    await expect(deleteComment("1' OR '1'='1", { db: "/tmp/x/.beads" })).rejects.toThrow(
      BdArgvError,
    )
  })
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
