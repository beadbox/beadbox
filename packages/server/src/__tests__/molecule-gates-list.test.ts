// Gates reach the molecule view (beadbox-wya0.1).
//
// bd hides gate issues from `bd list` unless --include-gates is passed, and the
// tree's list is shared by every view, so the molecule's gates come from their
// own gates-only list: one call per tree load, only when the list holds a
// molecule, and only gates whose parent chain reaches a molecule are kept.
// Ordinary epics and "Beads (No Epic)" never see a gate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getEpics } from "../handlers/epics"
import { __resetBdPathCache, listGates } from "../lib/bd"
import { invalidateEpicCache } from "../lib/epic-cache"
import type { Bead, Epic } from "../lib/types"

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

const AT = { priority: 2, labels: [], created_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:00:00Z" }
const child = (id: string, parent: string) => ({ issue_id: id, depends_on_id: parent, type: "parent-child" })

// A poured molecule (root t-mol-m, step epic t-mol-s) next to an ordinary epic.
const MOLECULE = [
  { ...AT, id: "t-mol-m", title: "mol", status: "open", issue_type: "molecule" },
  { ...AT, id: "t-mol-s", title: "Step one", status: "open", issue_type: "epic", parent: "t-mol-m", dependencies: [child("t-mol-s", "t-mol-m")] },
  {
    ...AT, id: "t-mol-t", title: "Ship", status: "open", issue_type: "task", parent: "t-mol-s",
    dependencies: [child("t-mol-t", "t-mol-s"), { issue_id: "t-mol-t", depends_on_id: "t-mol-gh", type: "blocks" }],
  },
]
const ORDINARY = [
  { ...AT, id: "t-e", title: "Epic E", status: "open", issue_type: "epic" },
  { ...AT, id: "t-a", title: "A", status: "open", issue_type: "task", parent: "t-e", dependencies: [child("t-a", "t-e")] },
]
// bd's gate rows: from a formula step's gate (parent = step epic), a gate
// directly under the root, one under an ordinary epic, and an ad-hoc gate
// from `bd gate create` (no parent).
const GATES = [
  { ...AT, id: "t-mol-gh", title: "Gate: human", status: "open", issue_type: "gate", await_type: "human", parent: "t-mol-s", dependencies: [child("t-mol-gh", "t-mol-s")] },
  { ...AT, id: "t-mol-gt", title: "Gate: timer", status: "closed", issue_type: "gate", await_type: "timer", timeout: 7200000000000, parent: "t-mol-m", dependencies: [child("t-mol-gt", "t-mol-m")] },
  { ...AT, id: "t-ge", title: "Gate: human", status: "open", issue_type: "gate", await_type: "human", parent: "t-e", dependencies: [child("t-ge", "t-e")] },
  { ...AT, id: "t-gx", title: "Gate: timer", status: "open", issue_type: "gate", await_type: "timer" },
]

/**
 * A server-mode workspace whose bd is a script that branches like bd 1.3.1:
 * plain `list` hides gates; `list --include-gates` adds them (`--type=gate`
 * narrows to gates); with `oldBd`, --include-gates is an unknown flag. Every
 * call is appended to calls.log.
 */
async function workspace(rows: object[], opts: { oldBd?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "beadbox-wya0-"))
  roots.push(root)
  const db = join(root, ".beads")
  await mkdir(db)
  await writeFile(join(db, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))
  const log = join(root, "calls.log")
  const bd = join(root, "bd")
  const includeGatesBranch = opts.oldBd
    ? `echo 'Error: unknown flag: --include-gates' >&2; exit 1`
    : `case " $* " in *" --type=gate "*) printf '%s\\n' '${JSON.stringify(GATES)}' ;; *) printf '%s\\n' '${JSON.stringify([...rows, ...GATES])}' ;; esac`
  await writeFile(
    bd,
    `#!/bin/sh
echo "$*" >> "${log}"
case " $* " in
  *" list "*" --include-gates "*) ${includeGatesBranch} ;;
  *" list "*) printf '%s\\n' '${JSON.stringify(rows)}' ;;
  *" sql "*) printf '[{"h":"head-1","i":"2026-10-28","c":"0"}]\\n' ;;
  *) echo '[]' ;;
esac
`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = bd
  __resetBdPathCache()
  const lists = async () =>
    (await readFile(log, "utf-8").catch(() => "")).split("\n").filter((c) => ` ${c} `.includes(" list "))
  return { db, lists }
}

function find(epics: Bead[], id: string): Bead | undefined {
  for (const e of epics) {
    if (e.id === id) return e
    const nested = [...(e.children ?? []), ...((e as Epic).childEpics ?? [])]
    const hit = find(nested, id)
    if (hit) return hit
  }
  return undefined
}

const childIds = (bead: Bead | undefined) => (bead?.children ?? []).map((c) => c.id).sort()

describe("listGates argv (beadbox-wya0.1)", () => {
  test("lists gates with --include-gates and no other --include-* flag", async () => {
    const ws = await workspace([])
    await listGates({ db: ws.db })
    const calls = await ws.lists()
    expect(calls).toHaveLength(1)
    const argv = calls[0]!.split(" ")
    expect(argv.slice(argv.indexOf("list"))).toEqual([
      "list", "--status", "all", "--limit", "0", "--flat", "--type=gate", "--include-gates", "--json",
    ])
    expect(argv).not.toContain("--include-infra")
    expect(argv).not.toContain("--include-templates")
  })

  test("a bd without --include-gates is the named error, never an empty list", async () => {
    const ws = await workspace([], { oldBd: true })
    await expect(listGates({ db: ws.db })).rejects.toThrow(
      "The installed bd does not support --include-gates",
    )
  })
})

describe("the tree's molecules get their gates (beadbox-wya0.1)", () => {
  test("a molecule's gates reach it; ordinary epics and standalone get none", async () => {
    const ws = await workspace([...MOLECULE, ...ORDINARY])
    const tree = await getEpics(ws.db)
    if (!tree.success) throw new Error(tree.bdLoadError.message)

    expect(childIds(find(tree.epics, "t-mol-s"))).toEqual(["t-mol-gh", "t-mol-t"])
    expect(childIds(find(tree.epics, "t-mol-m"))).toEqual(["t-mol-gt"])
    const gate = find(tree.epics, "t-mol-gh")
    expect(gate?.type).toBe("gate")
    expect(gate?.status).toBe("open")

    expect(childIds(find(tree.epics, "t-e"))).toEqual(["t-a"])
    expect(find(tree.epics, "t-ge")).toBeUndefined()
    expect(find(tree.epics, "t-gx")).toBeUndefined()

    const calls = await ws.lists()
    expect(calls).toHaveLength(2)
    expect(calls.filter((c) => c.includes("--include-gates"))).toHaveLength(1)
    expect(calls.join(" ")).not.toContain("--include-infra")
  })

  // beadbox-wya0.2: a gate row needs bd's kind and a timer's due time.
  test("a gate carries what it waits on; a task carries nothing", async () => {
    const ws = await workspace([...MOLECULE, ...ORDINARY])
    const tree = await getEpics(ws.db)
    if (!tree.success) throw new Error(tree.bdLoadError.message)
    expect(find(tree.epics, "t-mol-gh")?.gateWait).toEqual({ awaitType: "human" })
    // 2026-10-28T00:00:00Z + 7200000000000 ns (2h)
    expect(find(tree.epics, "t-mol-gt")?.gateWait).toEqual({
      awaitType: "timer",
      deadline: "2026-10-28T02:00:00.000Z",
    })
    expect(find(tree.epics, "t-mol-t")?.gateWait).toBeUndefined()
  })

  test("a list with no molecule runs no gates list", async () => {
    const ws = await workspace(ORDINARY)
    const tree = await getEpics(ws.db)
    expect(tree.success).toBe(true)
    expect((await ws.lists()).filter((c) => c.includes("--include-gates"))).toHaveLength(0)
  })

  test("All issues (includeSystem) keeps its one system-inclusive list", async () => {
    const ws = await workspace([...MOLECULE, ...ORDINARY])
    const tree = await getEpics(ws.db, true)
    expect(tree.success).toBe(true)
    const calls = await ws.lists()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("--include-infra")
  })

  test("a bd without --include-gates fails the load with the named error", async () => {
    const ws = await workspace([...MOLECULE, ...ORDINARY], { oldBd: true })
    const tree = await getEpics(ws.db)
    expect(tree.success).toBe(false)
    if (tree.success) return
    expect(tree.bdLoadError.message).toContain("does not support --include-gates")
  })
})
