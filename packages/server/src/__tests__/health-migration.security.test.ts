// runWorkspaceMigration path validation (beadbox-226).
//
// runWorkspaceMigration is webview-callable and runs a WRITE (`bd migrate
// --yes`) against the path the client sends. The client only ever sends back
// the workspacePath the server handed it (a registered .beads directory), so
// anything else is refused before bd is spawned: a relative path, a path with
// a NUL byte, a path that is not a .beads directory, and a well-formed path
// that is not a registered workspace. Every rejection must leave bd unspawned —
// the recording fake bd on BD_PATH is the observable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWorkspaceMigration } from "../handlers/health"
import { resetPathCaches } from "../lib/bd-paths"

const SHAPE = "(must be a .beads directory or a file inside one)"

const originalEnv = {
  BD_PATH: process.env.BD_PATH,
  BEADBOX_REGISTRY_PATH: process.env.BEADBOX_REGISTRY_PATH,
  BEADS_REGISTRY_PATH: process.env.BEADS_REGISTRY_PATH,
}
let root: string
let registered: string
let argvLog: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-226-"))
  registered = join(root, "proj", ".beads")
  await mkdir(registered, { recursive: true })
  await writeFile(
    join(root, "registry.json"),
    JSON.stringify({
      version: 2,
      activeWorkspace: "3f1b8a24-0000-4000-8000-000000000226",
      workspaces: [
        {
          id: "3f1b8a24-0000-4000-8000-000000000226",
          name: "proj",
          addedAt: "2026-09-25T00:00:00.000Z",
          local: { path: registered },
          server: null,
          mode: "embedded",
        },
      ],
    }),
  )
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
  process.env.BEADS_REGISTRY_PATH = join(root, "legacy-registry.json")

  argvLog = join(root, "argv.log")
  const fakeBd = join(root, "bd")
  await writeFile(fakeBd, `#!/bin/sh\necho "$*" >> "${argvLog}"\n`, { mode: 0o700 })
  process.env.BD_PATH = fakeBd
  resetPathCaches()
})

afterEach(async () => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetPathCaches()
  await rm(root, { recursive: true, force: true })
})

async function invocations(): Promise<string[]> {
  return (await readFile(argvLog, "utf-8").catch(() => "")).split("\n").filter(Boolean)
}

describe("runWorkspaceMigration refuses a path it did not hand out, before spawning bd", () => {
  const cases: Array<[string, () => string, string]> = [
    ["a relative path", () => "proj/.beads", SHAPE],
    ["a path containing NUL", () => `${registered}\0/x`, SHAPE],
    ["an absolute path that is not a .beads directory", () => join(root, "proj"), SHAPE],
    [
      "an unregistered .beads directory",
      () => join(root, "other", ".beads"),
      "(not a registered workspace)",
    ],
    ["a server:// URI (migrate needs a local path)", () => "server://127.0.0.1:3307/beads", SHAPE],
  ]

  for (const [label, path, reason] of cases) {
    test(`${label}: sibling-shaped error, bd never spawned`, async () => {
      const p = path()
      const result = await runWorkspaceMigration(p)
      expect(result).toEqual({ ok: false, error: `Invalid database path: ${p} ${reason}` })
      expect(await invocations()).toEqual([])
    })
  }
})

describe("runWorkspaceMigration still migrates a registered workspace", () => {
  test("spawns bd once, against the registered path", async () => {
    const result = await runWorkspaceMigration(registered)
    expect(result.ok).toBe(true)
    expect(await invocations()).toEqual([`migrate --db=${registered} --yes`])
  })
})
