// Blocked-by for the epic tree comes from `bd list --json` (beadbox-01f.5).
//
// It used to be raw SQL against the dependencies table, which broke twice:
// bd 1.2 renamed depends_on_id to depends_on_issue_id, and bd refuses `bd sql`
// in embedded mode (the `bd init` default), so most workspaces never saw a
// blocker. `bd list --json` carries each issue's dependencies with bd's own
// normalized `depends_on_id` in both modes (checked at bd 1.1.0 and 1.2.2).
// The schema-probing tests contributed with the first fix (PR #43, Sergey
// Belov) covered that SQL path and went with it; the cases they guarded
// (failure is an error, malformed output is an error, targetless edges are
// skipped) carry over below.

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBdPathCache, getAllBlocksDependencies } from "../lib/bd"

const originalBdPath = process.env.BD_PATH
let root: string | undefined

afterEach(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  __resetBdPathCache()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * A workspace whose `bd` is a shell script. Every invocation's args are
 * appended to calls.log so a test can see which bd commands actually ran.
 */
async function workspace(body: string, mode: "server" | "embedded"): Promise<{ beadsDir: string; calls: () => Promise<string[]> }> {
  root = await mkdtemp(join(tmpdir(), "beadbox-blocks-"))
  const beadsDir = join(root, ".beads")
  await mkdir(beadsDir)
  await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({ dolt_mode: mode }))
  const log = join(root, "calls.log")
  const bdPath = join(root, "bd")
  await writeFile(bdPath, `#!/bin/sh\necho "$*" >> "${log}"\n${body}\n`, { mode: 0o700 })
  process.env.BD_PATH = bdPath
  __resetBdPathCache()
  return {
    beadsDir,
    calls: async () => (await readFile(log, "utf-8").catch(() => "")).split("\n").filter(Boolean),
  }
}

// `bd list --status all --limit 0 --flat --json`, captured from bd 1.2.2 on a
// synthetic workspace: A (a child of epic E) is blocked by B and by C, and C is
// closed. A's parent-child link is a dependency row too. D has no dependencies,
// so bd omits the key.
const BD_1_2_2_LIST = [
  { id: "d122-cw8", title: "D", status: "open", issue_type: "task" },
  { id: "d122-m7l", title: "C", status: "closed", issue_type: "task" },
  { id: "d122-7k4", title: "B", status: "open", issue_type: "task" },
  {
    id: "d122-udr.1",
    title: "A",
    status: "open",
    issue_type: "task",
    parent: "d122-udr",
    dependencies: [
      { issue_id: "d122-udr.1", depends_on_id: "d122-udr", type: "parent-child", created_at: "2026-09-25T13:47:37Z", metadata: "{}" },
      { issue_id: "d122-udr.1", depends_on_id: "d122-7k4", type: "blocks", created_at: "2026-09-25T13:47:42Z", metadata: "{}" },
      { issue_id: "d122-udr.1", depends_on_id: "d122-m7l", type: "blocks", created_at: "2026-09-25T13:47:43Z", metadata: "{}" },
    ],
  },
  { id: "d122-udr", title: "Epic E", status: "open", issue_type: "epic" },
]

function listing(issues: unknown): string {
  // bd's global flags (--db ...) come before the subcommand.
  return `case " $* " in
  *" list "*) printf '%s\\n' '${JSON.stringify(issues)}' ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac`
}

for (const mode of ["embedded", "server"] as const) {
  test(`${mode} mode: blockers come from bd list, closed blockers included, parent-child excluded`, async () => {
    const { beadsDir, calls } = await workspace(listing(BD_1_2_2_LIST), mode)
    const result = await getAllBlocksDependencies({ db: beadsDir })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    // Same set `bd show d122-udr.1` lists as blocks dependencies.
    expect(result.map.get("d122-udr.1")).toEqual(["d122-7k4", "d122-m7l"])
    expect([...result.map.keys()]).toEqual(["d122-udr.1"])
    // One bd list call and no SQL: nothing here depends on table or column names.
    const issued = await calls()
    expect(issued).toHaveLength(1)
    expect(` ${issued[0]} `).toContain(" list ")
    expect(issued.some((c) => ` ${c} `.includes(" sql "))).toBe(false)
  })
}

test("a workspace with no blocks dependencies is an ok empty map", async () => {
  const { beadsDir } = await workspace(listing([{ id: "x-1", title: "X", status: "open", issue_type: "task" }]), "embedded")
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("ok")
  expect(result.status === "ok" && result.map.size).toBe(0)
})

test("a failing bd list is an error, not an empty map", async () => {
  const { beadsDir } = await workspace(`echo "Error: failed to open database" >&2; exit 1`, "embedded")
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("error")
})

test("a non-array result is reported as an error rather than iterated", async () => {
  const { beadsDir } = await workspace(listing({ error: "unexpected shape" }), "server")
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("error")
})

test("edges without a target are skipped, not rendered as a blank blocker", async () => {
  const { beadsDir } = await workspace(
    listing([
      {
        id: "y-1",
        title: "Y",
        status: "open",
        issue_type: "task",
        dependencies: [
          { issue_id: "y-1", depends_on_id: "", type: "blocks" },
          { issue_id: "y-1", type: "blocks" },
          { issue_id: "y-1", depends_on_id: "y-2", type: "blocks" },
        ],
      },
    ]),
    "embedded",
  )
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("ok")
  expect(result.status === "ok" && result.map.get("y-1")).toEqual(["y-2"])
})
