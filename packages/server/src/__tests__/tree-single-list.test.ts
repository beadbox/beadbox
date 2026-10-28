// One tree load, one full `bd list` (beadbox-w74).
//
// Blocked-by comes from `bd list --json` since beadbox-01f.5, and it used to
// run that full list a second time right after the tree had just run it: at
// 5000 issues that is ~15 MB twice per load and twice the transient memory.
// The tree's own list now also yields blocked-by, and getBlocksDependencies
// answers from it while the data is unchanged.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getBlocksDependencies, getEpics } from "../handlers/epics"
import { __resetBdPathCache } from "../lib/bd"
import { invalidateEpicCache } from "../lib/epic-cache"

const originalBdPath = process.env.BD_PATH
const roots: string[] = []

beforeEach(() => invalidateEpicCache())

afterEach(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  __resetBdPathCache()
  invalidateEpicCache()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

// bd 1.2.2's list shape: A (child of epic E) is blocked by B and by C (closed).
const LIST = [
  { id: "t-e", title: "Epic E", status: "open", priority: 2, issue_type: "epic", labels: [], created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" },
  {
    id: "t-a", title: "A", status: "open", priority: 2, issue_type: "task", labels: [], parent: "t-e",
    created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
    dependencies: [
      { issue_id: "t-a", depends_on_id: "t-e", type: "parent-child" },
      { issue_id: "t-a", depends_on_id: "t-b", type: "blocks" },
      { issue_id: "t-a", depends_on_id: "t-c", type: "blocks" },
    ],
  },
  { id: "t-b", title: "B", status: "open", priority: 2, issue_type: "task", labels: [], created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" },
  { id: "t-c", title: "C", status: "closed", priority: 2, issue_type: "task", labels: [], created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" },
]

/**
 * A server-mode workspace whose bd is a script: `list` prints LIST, the
 * fingerprint query prints the contents of head.txt (so a test can simulate
 * a write), anything else prints []. Every call is appended to calls.log.
 */
async function workspace(list: unknown[] = LIST): Promise<{ db: string; lists: () => Promise<number>; write: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "beadbox-w74-"))
  roots.push(root)
  const db = join(root, ".beads")
  await mkdir(db)
  await writeFile(join(db, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))
  const log = join(root, "calls.log")
  const head = join(root, "head.txt")
  await writeFile(head, "head-1")
  const bd = join(root, "bd")
  await writeFile(
    bd,
    `#!/bin/sh
echo "$*" >> "${log}"
case " $* " in
  *" list "*) printf '%s\\n' '${JSON.stringify(list)}' ;;
  *" sql "*) printf '[{"h":"%s","i":"2026-09-25","c":"0"}]\\n' "$(cat "${head}")" ;;
  *) echo '[]' ;;
esac
`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = bd
  __resetBdPathCache()
  const lists = async () =>
    (await readFile(log, "utf-8").catch(() => "")).split("\n").filter((c) => ` ${c} `.includes(" list ")).length
  return { db, lists, write: () => writeFile(head, "head-2") }
}

test("a tree load plus its blocked-by runs bd list exactly once", async () => {
  const ws = await workspace()
  const tree = await getEpics(ws.db)
  expect(tree.success).toBe(true)
  const blocks = await getBlocksDependencies(ws.db)

  expect(blocks.degraded).toBeUndefined()
  expect(blocks.blockedBy["t-a"]).toEqual(["t-b", "t-c"])
  expect(Object.keys(blocks.blockedBy)).toEqual(["t-a"])
  expect(await ws.lists()).toBe(1)
})

test("after a write, blocked-by is read fresh, not from the old tree's list", async () => {
  const ws = await workspace()
  await getEpics(ws.db)
  await ws.write() // the data changed after the tree loaded
  const blocks = await getBlocksDependencies(ws.db)
  expect(blocks.blockedBy["t-a"]).toEqual(["t-b", "t-c"])
  expect(await ws.lists()).toBe(2)
})

test("blocked-by for another workspace never comes from this one's tree", async () => {
  const first = await workspace()
  await getEpics(first.db)
  const second = await workspace()
  const blocks = await getBlocksDependencies(second.db)
  expect(blocks.blockedBy["t-a"]).toEqual(["t-b", "t-c"])
  expect(await second.lists()).toBe(1) // its own list, since it has no tree loaded
})

// beadbox-kqiv: the tree carries blocked-by itself. It used to arrive without
// it and get it patched in by the client from a second request, so for a few
// frames after every change a molecule's steps all sat in Phase 1.
test("tree beads carry blocked-by, with titles, from the same single list", async () => {
  const ws = await workspace()
  const tree = await getEpics(ws.db)
  if (!tree.success) throw new Error("tree load failed")
  const a = tree.epics.find((e) => e.id === "t-e")?.children.find((c) => c.id === "t-a")
  expect(a?.id).toBe("t-a")
  expect(a?.blockedBy).toEqual([
    { id: "t-b", title: "B" },
    { id: "t-c", title: "C" },
  ])
  const b = tree.epics.find((e) => e.id === "_standalone")?.children.find((c) => c.id === "t-b")
  expect(b?.id).toBe("t-b")
  expect(b?.blockedBy).toBeUndefined() // unblocked beads carry none
  expect(await ws.lists()).toBe(1)
})

test("a blocker missing from the list shows by its id", async () => {
  const ws = await workspace([
    ...LIST,
    {
      id: "t-d", title: "D", status: "open", priority: 2, issue_type: "task", labels: [],
      created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
      dependencies: [{ issue_id: "t-d", depends_on_id: "t-gone", type: "blocks" }],
    },
  ])
  const tree = await getEpics(ws.db)
  if (!tree.success) throw new Error("tree load failed")
  const d = tree.epics.find((e) => e.id === "_standalone")?.children.find((c) => c.id === "t-d")
  expect(d?.id).toBe("t-d")
  expect(d?.blockedBy).toEqual([{ id: "t-gone", title: "t-gone" }])
})

test("a blocked epic carries blocked-by too", async () => {
  const ws = await workspace([
    ...LIST.map((b) =>
      b.id === "t-e" ? { ...b, dependencies: [{ issue_id: "t-e", depends_on_id: "t-b", type: "blocks" }] } : b,
    ),
  ])
  const tree = await getEpics(ws.db)
  if (!tree.success) throw new Error("tree load failed")
  const e = tree.epics.find((x) => x.id === "t-e")
  expect(e?.id).toBe("t-e")
  expect(e?.blockedBy).toEqual([{ id: "t-b", title: "B" }])
})
