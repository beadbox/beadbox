// beadbox-287: a server workspace's scaffold must adopt the served database's
// project identity. Without --database, bd init mints a new _project_id and
// writes it back into the served database, locking out every other client.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBdPathCache, initServerScaffold } from "../lib/bd"

const SERVER = { host: "db.example.test", port: 3307, database: "team_beads", user: "alice" }

describe("initServerScaffold (beadbox-287)", () => {
  const originalBdPath = process.env.BD_PATH
  let root: string
  let scaffold: string
  let log: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "beadbox-287-"))
    scaffold = join(root, "workspaces", "ws-1")
    await mkdir(scaffold, { recursive: true })
    log = join(root, "argv.log")
    const fakeBd = join(root, "bd")
    // Records argv, then does what a real init does to the cwd: creates .beads.
    await writeFile(
      fakeBd,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nmkdir -p .beads\necho '{"project_id":"adopted"}' > .beads/metadata.json\n`,
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

  test("names the served database with --database, so bd adopts its project identity", async () => {
    await initServerScaffold(scaffold, SERVER)
    const argv = (await readFile(log, "utf-8")).trim().split("\n")
    expect(argv[0]).toBe("init")
    expect(argv).toContain("--database=team_beads")
    expect(argv).toContain("--external")
  })

  test("moves a stale scaffold aside instead of re-initialising over it", async () => {
    // A scaffold minted by an earlier version carries its own project_id; bd
    // refuses to re-init over it and would keep the stale identity.
    await mkdir(join(scaffold, ".beads"))
    await writeFile(join(scaffold, ".beads", "metadata.json"), '{"project_id":"stale"}')

    await initServerScaffold(scaffold, SERVER)

    const entries = await readdir(scaffold)
    const stale = entries.filter((e) => e.startsWith(".beads.stale-"))
    expect(stale).toHaveLength(1)
    expect(await readFile(join(scaffold, stale[0], "metadata.json"), "utf-8")).toContain("stale")
    expect(await readFile(join(scaffold, ".beads", "metadata.json"), "utf-8")).toContain("adopted")
  })

  test("leaves the directory alone when there is no previous scaffold", async () => {
    await initServerScaffold(scaffold, SERVER)
    expect((await readdir(scaffold)).filter((e) => e.startsWith(".beads.stale-"))).toEqual([])
  })
})
