// beadbox-fdk: a registered workspace whose .beads has vanished (moved,
// renamed, a branch or worktree without it, an unmounted volume) must be an
// ERROR, never an init opportunity. Pointed at a missing .beads, bd writes a
// 2.1 MB embeddeddolt/ into the project and then reports an empty issue list
// at exit 0, so the workspace looks legitimately empty. Beadbox must not run
// bd there at all, and must say why.
//
// PRESENT := <.beads>/metadata.json OR <.beads>/config.yaml. Not "the
// directory exists": bd's own litter recreates .beads with only
// .local_version + embeddeddolt/, and a genuine init always writes both files.
// Synthetic workspaces only.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as bd from "../lib/bd"
import { resetPathCaches } from "../lib/bd-paths"
import * as detector from "../lib/change-detector"
import * as health from "../lib/workspace-health"
import type { RegistryEntry } from "../lib/workspace-registry"

setDefaultTimeout(60_000)

const originalBdPath = process.env.BD_PATH
let root: string
let project: string
let beads: string
let log: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-fdk-"))
  project = join(root, "project")
  beads = join(project, ".beads")
  await mkdir(project)
  log = join(root, "bd.log")
  const fakeBd = join(root, "bd")
  await writeFile(
    fakeBd,
    `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in *version*) echo "bd version 1.2.2 (Homebrew)";; *) echo '[]';; esac\n`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = fakeBd
  resetPathCaches()
  bd.__resetBdPathCache()
})

afterEach(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  resetPathCaches()
  bd.__resetBdPathCache()
  await rm(root, { recursive: true, force: true })
})

async function spawnsOf(sub: string): Promise<number> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter((l) => l.split(" ").includes(sub))
      .length
  } catch {
    return 0
  }
}

function entry(): RegistryEntry {
  return {
    id: "fdk-test",
    name: "fdk",
    addedAt: "2026-09-25T00:00:00Z",
    local: { path: beads },
    server: null,
    mode: "embedded",
  }
}

describe("bd.ts refuses a vanished workspace before spawning bd", () => {
  test("missing .beads: listBeads throws database-not-found, bd never runs", async () => {
    let error: unknown = null
    await bd.listBeads({ db: join(beads, "beads.db") }).catch((e) => {
      error = e
    })
    expect(error).toMatchObject({
      category: "database-not-found",
      severity: "fatal",
      fixCommand: null,
    })
    expect(await spawnsOf("list")).toBe(0)
  })

  test("bd's litter (.local_version + embeddeddolt/ only) is still a vanished workspace", async () => {
    await mkdir(join(beads, "embeddeddolt", "beads", ".dolt"), { recursive: true })
    await writeFile(join(beads, ".local_version"), "1.2.2")
    await expect(bd.listBeads({ db: join(beads, "beads.db") })).rejects.toMatchObject({
      category: "database-not-found",
    })
    expect(await spawnsOf("list")).toBe(0)
  })

  test.each([
    "metadata.json",
    "config.yaml",
  ])("a genuine .beads (%s) runs bd as before", async (file) => {
    await mkdir(beads)
    await writeFile(join(beads, file), file === "metadata.json" ? "{}" : "")
    expect(await bd.listBeads({ db: join(beads, "beads.db") })).toEqual([])
    expect(await spawnsOf("list")).toBe(1)
  })
})

describe("the health check names it", () => {
  test("a registered local workspace with no .beads is workspace_missing, not ok", async () => {
    const result = await health.checkHealth(entry())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatchObject({ kind: "workspace_missing", path: beads })
    expect(await spawnsOf("list")).toBe(0)
  })
})

describe("the server-mode poll loop never runs bd on a vanished workspace", () => {
  function runLoop(beadsDir: string) {
    const args = (detector.buildPollShellArgs as (...a: unknown[]) => string[])(
      "fdk-loop",
      join(beads, "beads.db"),
      process.env.BD_PATH,
      2,
      "", // log path (beadbox-01f.4): none here
      beadsDir,
    )
    const child = spawn("/bin/sh", args, { stdio: ["pipe", "ignore", "pipe"], detached: true })
    const lines: string[] = []
    child.stderr?.on("data", (b: Buffer) => lines.push(...b.toString().split("\n").filter(Boolean)))
    return { child, lines }
  }
  const kill = (pid?: number) => {
    try {
      if (pid) process.kill(-pid, "SIGKILL")
    } catch {
      /* gone */
    }
  }

  test("vanished .beads: no bd spawns, and polling_error after three loops", async () => {
    const { child, lines } = runLoop(beads)
    try {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && !lines.some((l) => l.includes('"polling_error"'))) {
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(lines.some((l) => l.includes('"polling_error"'))).toBe(true)
      expect(await spawnsOf("sql")).toBe(0)
    } finally {
      kill(child.pid)
    }
  })

  test("no local .beads to check (server://): bd runs as before", async () => {
    const { child } = runLoop("")
    try {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && (await spawnsOf("sql")) === 0) {
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(await spawnsOf("sql")).toBeGreaterThan(0)
    } finally {
      kill(child.pid)
    }
  })
})

describe("real bd: nothing is written into the project", () => {
  test("listBeads on a vanished workspace throws and leaves the project dir empty", async () => {
    delete process.env.BD_PATH
    resetPathCaches()
    bd.__resetBdPathCache()
    await expect(bd.listBeads({ db: join(beads, "beads.db") })).rejects.toMatchObject({
      category: "database-not-found",
    })
    expect(await readdir(project)).toEqual([])
  })
})
