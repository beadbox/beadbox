import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetBdPathCache,
  deleteComment,
  getAllBlocksDependencies,
  getChangedBeadIds,
  getDataFingerprint,
} from "../lib/bd"
import { readOnlyQuery, type SqlConnection } from "../lib/read-only-query"

const originalBdPath = process.env.BD_PATH
let root: string | undefined

afterEach(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  __resetBdPathCache()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

// Contributed in PR #44; adapted to getAllBlocksDependencies' result shape.
test("read-only SQL calls succeed while comment deletion remains writable", async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-readonly-sql-"))
  const beadsDir = join(root, ".beads")
  await mkdir(beadsDir)
  await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))
  const bdPath = join(root, "bd")
  await writeFile(
    bdPath,
    `#!/bin/sh
case "$*" in
  *"DELETE FROM comments"*)
    case " $* " in *" --readonly "*) exit 11 ;; esac
    exit 0 ;;
esac
case " $* " in *" --readonly "*) ;; *) exit 12 ;; esac
case "$*" in
  *"HASHOF"*) echo '[{"h":"head-a","i":"2026-01-01","c":0}]' ;;
  *"updated_at >"*) echo '[{"id":"task-a"}]' ;;
  *"FROM dependencies"*) echo '[{"issue_id":"task-a","depends_on_id":"task-b"}]' ;;
  *) exit 13 ;;
esac
`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = bdPath
  __resetBdPathCache()

  expect(await getDataFingerprint({ db: beadsDir })).toContain("head-a")
  expect(await getChangedBeadIds("2026-01-01T00:00:00Z", { db: beadsDir })).toEqual(["task-a"])
  const blocks = await getAllBlocksDependencies({ db: beadsDir })
  expect(blocks.status).toBe("ok")
  expect(blocks.status === "ok" && blocks.map.get("task-a")).toEqual(["task-b"])
  await expect(deleteComment(42, { db: beadsDir })).resolves.toBeUndefined()
})

// server:// workspaces bypass the bd CLI (direct mysql2), so --readonly cannot
// reach them; readOnlyQuery is their guard. A fake connection records the
// statements and plays the server's part.
function fakeConnection(refuse: (sql: string) => Error | undefined) {
  const statements: string[] = []
  const conn: SqlConnection = {
    async query(sql: string) {
      statements.push(sql)
      const error = refuse(sql)
      if (error) throw error
      return [[{ id: "task-a" }], []]
    },
  }
  return { conn, statements }
}

test("server-mode reads run inside a transaction the server enforces as read-only", async () => {
  const { conn, statements } = fakeConnection(() => undefined)
  expect(await readOnlyQuery(conn, "SELECT id FROM issues")).toEqual([{ id: "task-a" }])
  expect(statements).toEqual(["START TRANSACTION READ ONLY", "SELECT id FROM issues", "COMMIT"])
})

test("a statement refused inside the read-only transaction propagates, not an empty read", async () => {
  const refused = new Error("cannot execute statement in a READ ONLY transaction")
  const { conn, statements } = fakeConnection((sql) => (sql.startsWith("DELETE") ? refused : undefined))
  await expect(readOnlyQuery(conn, "DELETE FROM comments WHERE id = 1")).rejects.toBe(refused)
  expect(statements).toEqual(["START TRANSACTION READ ONLY", "DELETE FROM comments WHERE id = 1", "ROLLBACK"])
})

test("a failed ROLLBACK does not replace the original error", async () => {
  const refused = new Error("refused")
  const { conn } = fakeConnection((sql) =>
    sql === "ROLLBACK" ? new Error("connection lost") : sql.startsWith("DELETE") ? refused : undefined,
  )
  await expect(readOnlyQuery(conn, "DELETE FROM comments")).rejects.toBe(refused)
})

test("a server that rejects READ ONLY transactions fails the read instead of reading unguarded", async () => {
  const unsupported = new Error("syntax error near 'READ ONLY'")
  const { conn, statements } = fakeConnection((sql) => (sql.startsWith("START TRANSACTION") ? unsupported : undefined))
  await expect(readOnlyQuery(conn, "SELECT id FROM issues")).rejects.toBe(unsupported)
  expect(statements).toEqual(["START TRANSACTION READ ONLY"])
})
