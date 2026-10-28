// Which molecules belong to a formula (beadbox-ptca.5, spec §4.8.4).
//
// bd 1.3 pours a root of type "molecule" under the workspace's own prefix
// (<prefix>-mol-<hash>), titled exactly with the formula name; bd exposes no
// other link from a molecule to its formula. Older pours are epics with -mol-
// in the id whose title starts with the formula name. Step epics of a nested
// molecule also carry -mol- ids but have a parent, and are never cards.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadFormulaMolecules } from "../handlers/formulas"
import { __resetBdPathCache, listMoleculesForFormula } from "../lib/bd"

const originalBdPath = process.env.BD_PATH
const roots: string[] = []

afterEach(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  __resetBdPathCache()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const AT = { priority: 2, created_at: "2026-10-28T00:00:00Z", updated_at: "2026-10-28T00:00:00Z" }

const ROWS = [
  // bd 1.3 pours, non-bb prefix: probe-flow twice, probe-flow-v2 once.
  { ...AT, id: "spk-mol-a1", title: "probe-flow", status: "open", issue_type: "molecule" },
  { ...AT, id: "spk-mol-a2", title: "probe-flow", status: "closed", issue_type: "molecule" },
  { ...AT, id: "spk-mol-b1", title: "probe-flow-v2", status: "open", issue_type: "molecule" },
  // A nested molecule's step epic: -mol- id, title shares the prefix, has a parent.
  { ...AT, id: "spk-mol-s1", title: "probe-flow step", status: "open", issue_type: "epic", parent: "spk-mol-a1" },
  // A pour from before bd 1.3: epic, -mol- id, title starts with the formula name.
  { ...AT, id: "bb-mol-abc", title: "probe-flow something", status: "open", issue_type: "epic" },
  // An ordinary epic whose title happens to start with the formula name.
  { ...AT, id: "spk-e1", title: "probe-flow docs", status: "open", issue_type: "epic" },
  { ...AT, id: "spk-t1", title: "probe-flow", status: "open", issue_type: "task" },
]

/**
 * A server-mode workspace whose bd is a script that branches like bd on
 * `list --type=<t>`: only rows of that type come back. With `rejectMolecule`,
 * --type=molecule is an error (a bd that does not know the type). Every call
 * is appended to calls.log.
 */
async function workspace(opts: { rejectMolecule?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "beadbox-ptca5-"))
  roots.push(root)
  const db = join(root, ".beads")
  await mkdir(db)
  await writeFile(join(db, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))
  const log = join(root, "calls.log")
  const bd = join(root, "bd")
  const ofType = (t: string) => JSON.stringify(ROWS.filter((r) => r.issue_type === t))
  const moleculeBranch = opts.rejectMolecule
    ? `echo 'Error: invalid issue type "molecule"' >&2; exit 1`
    : `printf '%s\\n' '${ofType("molecule")}'`
  await writeFile(
    bd,
    `#!/bin/sh
echo "$*" >> "${log}"
case " $* " in
  *" list "*" --type=molecule "*) ${moleculeBranch} ;;
  *" list "*" --type=epic "*) printf '%s\\n' '${ofType("epic")}' ;;
  *" list "*) printf '%s\\n' '${JSON.stringify(ROWS)}' ;;
  *" mol progress "*) echo '{"molecule_id":"x","molecule_title":"x","total":2,"completed":1,"in_progress":0,"percent":50}' ;;
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

const ids = (cards: Array<{ id: string }>) => cards.map((c) => c.id).sort()

describe("listMoleculesForFormula (beadbox-ptca.5)", () => {
  test("lists bd 1.3 molecule roots of any prefix whose title is the formula name", async () => {
    const ws = await workspace()
    const cards = await listMoleculesForFormula("probe-flow", { db: ws.db })
    expect(ids(cards)).toEqual(["bb-mol-abc", "spk-mol-a1", "spk-mol-a2"])
  })

  test("a formula whose name merely starts with another's lists only its own", async () => {
    const ws = await workspace()
    expect(ids(await listMoleculesForFormula("probe-flow-v2", { db: ws.db }))).toEqual(["spk-mol-b1"])
  })

  test("step epics, ordinary epics and tasks are never cards", async () => {
    const ws = await workspace()
    const listed = ids(await listMoleculesForFormula("probe-flow", { db: ws.db }))
    expect(listed).not.toContain("spk-mol-s1")
    expect(listed).not.toContain("spk-e1")
    expect(listed).not.toContain("spk-t1")
  })

  test("a closed molecule keeps its status, for the completed group", async () => {
    const ws = await workspace()
    const cards = await listMoleculesForFormula("probe-flow", { db: ws.db })
    expect(cards.find((c) => c.id === "spk-mol-a2")?.status).toBe("closed")
  })

  test("no match is an empty list", async () => {
    const ws = await workspace()
    expect(await listMoleculesForFormula("no-such-formula", { db: ws.db })).toEqual([])
  })

  test("lists molecules and epics by type, all statuses, unpaginated", async () => {
    const ws = await workspace()
    await listMoleculesForFormula("probe-flow", { db: ws.db })
    const calls = (await ws.lists()).map((c) => {
      const argv = c.split(" ")
      return argv.slice(argv.indexOf("list"))
    })
    expect(calls).toHaveLength(2)
    for (const type of ["molecule", "epic"]) {
      expect(calls).toContainEqual([
        "list", "--status", "all", "--limit", "0", "--flat", `--type=${type}`, "--json",
      ])
    }
  })

  test("a bd that rejects the molecule type is the handler's Failure, not a crash", async () => {
    const ws = await workspace({ rejectMolecule: true })
    const r = await loadFormulaMolecules("probe-flow", ws.db)
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toContain("molecule")
  })
})
