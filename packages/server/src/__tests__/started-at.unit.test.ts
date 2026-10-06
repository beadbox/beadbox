import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBdPathCache } from "../lib/bd"
import { __resetStartedAtState, beadsNeedingStartedAt, recordStartedAt } from "../lib/started-at"
import type { Bead, Epic } from "../lib/types"

function bead(id: string, status: string, metadata?: Record<string, string>): Bead {
  return { id, type: "task", title: id, description: "", status, priority: "medium", assignee: "", comments: [], metadata }
}

function epic(id: string, status: string, children: Bead[], childEpics: Epic[] = []): Epic {
  return { ...bead(id, status), type: "epic", children, childEpics }
}

const ids = (beads: Bead[]) => beads.map((b) => b.id).sort()

describe("beadsNeedingStartedAt", () => {
  test("selects in_progress and custom statuses; skips open, deferred, blocked, closed", () => {
    const tree = [
      epic("e", "open", [
        bead("a", "in_progress"),
        bead("b", "ready_for_qa"),
        bead("c", "open"),
        bead("d", "deferred"),
        bead("f", "blocked"),
        bead("g", "closed"),
      ]),
    ]
    expect(ids(beadsNeedingStartedAt(tree))).toEqual(["a", "b"])
  })

  test("skips a bead that already has started_at", () => {
    const tree = [epic("e", "open", [bead("a", "in_progress", { started_at: "2026-10-01T00:00:00Z" })])]
    expect(beadsNeedingStartedAt(tree)).toEqual([])
  })

  test("walks subtasks, nested epics, and the epics themselves", () => {
    const sub = { ...bead("parent", "open"), children: [bead("sub", "in_progress")] }
    const tree = [epic("top", "in_progress", [sub], [epic("child", "in_progress", [bead("deep", "in_progress")])])]
    expect(ids(beadsNeedingStartedAt(tree))).toEqual(["child", "deep", "sub", "top"])
  })

  test("lists a bead reachable twice only once", () => {
    const shared = bead("x", "in_progress")
    const tree = [epic("e1", "open", [shared]), epic("e2", "open", [shared])]
    expect(ids(beadsNeedingStartedAt(tree))).toEqual(["x"])
  })
})

describe("recordStartedAt", () => {
  const originalBdPath = process.env.BD_PATH
  const T = new Date("2026-10-06T09:56:54Z")
  let root: string
  let db: string
  let log: string

  // exitCode 0 = bd accepts the write, 1 = bd refuses it (e.g. read-only replica)
  async function fakeBd(exitCode: number) {
    const path = join(root, "bd")
    await writeFile(path, `#!/bin/sh\nprintf '%s\\037' "$@" >> "${log}"\nprintf '\\036' >> "${log}"\nexit ${exitCode}\n`, {
      mode: 0o700,
    })
    process.env.BD_PATH = path
    __resetBdPathCache()
  }

  async function updates(): Promise<string[][]> {
    const raw = await readFile(log, "utf-8").catch(() => "")
    return raw
      .split("\x1e")
      .filter(Boolean)
      .map((rec) => rec.split("\x1f").slice(0, -1))
      .filter((argv) => argv.includes("update"))
  }

  const started = (id: string, metadata?: Record<string, string>) => ({ ...bead(id, "in_progress", metadata), updatedAt: T })

  beforeEach(async () => {
    __resetStartedAtState()
    root = await mkdtemp(join(tmpdir(), "beadbox-started-at-"))
    db = join(root, ".beads")
    await mkdir(db)
    await writeFile(join(db, "metadata.json"), "{}")
    log = join(root, "argv.log")
  })

  afterEach(async () => {
    if (originalBdPath === undefined) delete process.env.BD_PATH
    else process.env.BD_PATH = originalBdPath
    __resetBdPathCache()
    await rm(root, { recursive: true, force: true })
  })

  test("patches the tree and writes updated_at once per selected bead", async () => {
    await fakeBd(0)
    const a = started("a")
    const b = started("b")
    const tree = [epic("e", "open", [a, b, bead("c", "open")])]
    const done = recordStartedAt(tree, { db })
    // The reply is right before any write has finished.
    expect(a.metadata?.started_at).toBe(T.toISOString())
    await done
    const calls = await updates()
    expect(calls.length).toBe(2)
    expect(calls.map((argv) => argv.find((t) => t.startsWith("--set-metadata=")))).toEqual([
      `--set-metadata=started_at=${T.toISOString()}`,
      `--set-metadata=started_at=${T.toISOString()}`,
    ])
  })

  test("writes nothing once the key is present", async () => {
    await fakeBd(0)
    await recordStartedAt([epic("e", "open", [started("a", { started_at: "2026-10-01T00:00:00Z" })])], { db })
    expect(await updates()).toEqual([])
  })

  test("does not send a second write for a bead whose write is still running", async () => {
    await fakeBd(0)
    const first = recordStartedAt([epic("e", "open", [started("a")])], { db })
    const second = recordStartedAt([epic("e", "open", [started("a")])], { db })
    await Promise.all([first, second])
    expect((await updates()).length).toBe(1)
  })

  test("a failing write never throws, is not retried, and leaves the bar on created_at", async () => {
    await fakeBd(1)
    await expect(recordStartedAt([epic("e", "open", [started("a")])], { db })).resolves.toBeUndefined()
    const again = started("a")
    await recordStartedAt([epic("e", "open", [again])], { db })
    expect((await updates()).length).toBe(1)
    expect(again.metadata?.started_at).toBeUndefined()
  })
})
