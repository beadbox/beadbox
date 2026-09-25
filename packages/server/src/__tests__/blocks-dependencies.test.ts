import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBdPathCache, __resetBlocksSchemaCache, getAllBlocksDependencies } from "../lib/bd"

const originalBdPath = process.env.BD_PATH
let root: string | undefined

afterEach(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  __resetBdPathCache()
  __resetBlocksSchemaCache()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * A server-mode workspace whose `bd` is a shell script standing in for a
 * specific bd version's SQL surface. Every invocation's args are appended to
 * calls.log so tests can count how many queries were actually issued.
 */
async function workspace(body: string, mode = "server"): Promise<{ beadsDir: string; calls: () => Promise<string[]> }> {
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

// bd >= 1.2: the column is depends_on_issue_id; the old name is rejected.
const BD_1_2 = `case "$*" in
  *depends_on_issue_id*) printf '[{"issue_id":"task-a","depends_on_id":"task-b"}]\\n' ;;
  *) printf '{"error":"column \\\\"depends_on_id\\\\" could not be found"}\\n'; exit 1 ;;
esac`

// bd 1.0.x (below MIN_BD_VERSION since beadbox-piv): only depends_on_id exists.
const BD_1_0 = `case "$*" in
  *depends_on_issue_id*) printf '{"error":"column \\\\"depends_on_issue_id\\\\" could not be found"}\\n'; exit 1 ;;
  *depends_on_id*) printf '[{"issue_id":"task-a","depends_on_id":"task-b"}]\\n' ;;
esac`

// Contributed with the original fix (PR #43, Sergey Belov): the current schema.
test("server mode returns a task's blockers from the Beads dependency schema", async () => {
  const { beadsDir } = await workspace(BD_1_2)
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("ok")
  if (result.status === "ok") expect(result.map.get("task-a")).toEqual(["task-b"])
})

// The case the original fix missed: querying only the new column broke every
// workspace on bd 1.0.x, silently, because failure used to read as "no blockers".
test("bd 1.0.x (legacy schema) still resolves blockers via the legacy column", async () => {
  const { beadsDir } = await workspace(BD_1_0)
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("ok")
  if (result.status === "ok") expect(result.map.get("task-a")).toEqual(["task-b"])
})

// Without the cache, every load on 1.0.x would issue one failing query first and
// put an error in the Dolt server log each time -- the symptom that found this bug.
test("the working schema is remembered: a second load on bd 1.0.x issues one query, not two", async () => {
  const { beadsDir, calls } = await workspace(BD_1_0)
  await getAllBlocksDependencies({ db: beadsDir })
  const afterFirst = (await calls()).length
  await getAllBlocksDependencies({ db: beadsDir })
  expect(afterFirst).toBe(2) // detection: new column fails, legacy succeeds
  expect((await calls()).length - afterFirst).toBe(1)
})

// THE REGRESSION TEST FOR THE SWALLOW: a failed query must not look like "no blockers".
test("a query that fails on every schema is an error, not an empty map", async () => {
  const { beadsDir } = await workspace(`printf '{"error":"dolt is down"}\\n'; exit 1`)
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("error")
})

test("a non-array result is reported as an error rather than iterated", async () => {
  const { beadsDir } = await workspace(`printf '{"unexpected":true}\\n'`)
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("error")
})

test("embedded mode is 'unsupported', not an empty success", async () => {
  const { beadsDir, calls } = await workspace(BD_1_2, "embedded")
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("unsupported")
  expect(await calls()).toEqual([]) // bd sql is never attempted there
})

// A blocks row whose target is a wisp or external ref has no issue id to show.
test("rows without an issue target are skipped, not rendered as null", async () => {
  const { beadsDir } = await workspace(
    `printf '[{"issue_id":"task-a","depends_on_id":"task-b"},{"issue_id":"task-a","depends_on_id":null}]\\n'`,
  )
  const result = await getAllBlocksDependencies({ db: beadsDir })
  expect(result.status).toBe("ok")
  if (result.status === "ok") expect(result.map.get("task-a")).toEqual(["task-b"])
})
