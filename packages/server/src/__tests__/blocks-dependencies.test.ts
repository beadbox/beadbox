import { afterEach, expect, mock, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAllBlocksDependencies } from "../lib/bd"

let root: string | undefined

afterEach(async () => {
  mock.restore()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

test("server mode returns a task's blockers from the Beads dependency schema", async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-blocks-"))
  const beadsDir = join(root, ".beads")
  await mkdir(beadsDir)
  await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))

  // The SQL pool verifies the real Beads dependency column while keeping
  // this unit test independent of a running Dolt server.
  mock.module("../lib/dolt-pool", () => ({
    getPool: async () => ({
      query: async (sql: string) => {
        if (!sql.includes("depends_on_issue_id AS depends_on_id")) throw new Error("wrong schema")
        return [[{ issue_id: "task-a", depends_on_id: "task-b" }]]
      },
    }),
  }))

  const blockers = await getAllBlocksDependencies({ db: beadsDir })
  expect(blockers.get("task-a")).toEqual(["task-b"])
})
