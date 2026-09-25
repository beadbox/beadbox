// beadbox-uk2: the tree load runs `bd list --status all --limit 0 --flat --json`
// through one execFile call. Its stdout cap is a stated ceiling
// (LIST_MAX_BUFFER, 32 MiB), above the 10 MiB every other bd call keeps.
// Past the ceiling the tree must fail with a named, non-retrying error — not
// an empty tree behind an auto-retry that can never succeed.
//
// Fixtures are synthetic: a fake bd (BD_PATH) answers `list` from a JSON file
// and every other subcommand with "[]".

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getEpics } from "../handlers/epics"
import * as bd from "../lib/bd"

const { __resetBdPathCache, showBead } = bd
// Read through the namespace so this file loads (and fails on behaviour) against
// a bd.ts that predates the constant.
const LIST_MAX_BUFFER: number = (bd as { LIST_MAX_BUFFER?: number }).LIST_MAX_BUFFER ?? 0

setDefaultTimeout(30_000)

const MiB = 1024 * 1024

// ~2.7 KB per issue, the shape eng1 measured on our tracker (beadbox-6x2).
function listJson(bytes: number): string {
  const parts: string[] = []
  let size = 2
  for (let i = 0; size < bytes; i++) {
    const issue = JSON.stringify({
      id: `bb-${i.toString(36)}`,
      title: `Synthetic issue ${i}`,
      description: "d".repeat(1800),
      acceptance_criteria: "a".repeat(300),
      notes: "n".repeat(200),
      status: "open",
      priority: 2,
      issue_type: i % 50 === 0 ? "epic" : "task",
      created_at: "2026-09-25T00:00:00Z",
      updated_at: "2026-09-25T00:00:00Z",
      ...(i % 50 === 0 ? {} : { parent: `bb-${(i - (i % 50)).toString(36)}` }),
    })
    parts.push(issue)
    size += issue.length + 1
  }
  return `[${parts.join(",")}]`
}

describe("whole-workspace list output cap (beadbox-uk2)", () => {
  const originalBdPath = process.env.BD_PATH
  let root: string
  let db: string
  let fixture: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "beadbox-uk2-"))
    db = join(root, ".beads")
    await mkdir(db)
    // A genuine workspace marker: bd is never run on a .beads without one (beadbox-fdk).
    await writeFile(join(db, "metadata.json"), "{}")
    fixture = join(root, "list.json")
    const fakeBd = join(root, "bd")
    await writeFile(
      fakeBd,
      `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in list|show) exec cat "${fixture}" ;; esac\ndone\necho '[]'\n`,
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

  test("states a ceiling of at least the 6x2 bench value (32 MiB)", () => {
    expect(LIST_MAX_BUFFER).toBeGreaterThanOrEqual(33_554_432)
  })

  test("a tree whose bd list output is over 10 MiB loads", async () => {
    await writeFile(fixture, listJson(12 * MiB))
    const result = await getEpics(db)
    if (!result.success)
      throw new Error(`expected success, got ${JSON.stringify(result.bdLoadError)}`)
    expect(result.epics.length).toBeGreaterThan(0)
  })

  test("past the ceiling the tree fails with a named, non-retrying error", async () => {
    await writeFile(fixture, listJson(Math.max(LIST_MAX_BUFFER, 32 * MiB) + MiB))
    const result = await getEpics(db)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.bdLoadError.category).toBe("output-too-large")
    expect(result.bdLoadError.severity).toBe("fatal")
    expect(result.bdLoadError.message).toContain("32 MiB")
  })

  test("other bd calls keep the 10 MiB cap", async () => {
    await writeFile(fixture, listJson(11 * MiB))
    await expect(showBead("bb-0", { db })).rejects.toMatchObject({ category: "output-too-large" })
  })
})
