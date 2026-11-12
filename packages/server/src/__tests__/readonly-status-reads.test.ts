import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetBdPathCache,
  getAvailableTypes,
  getCustomStatusEntries,
  getEpicStatuses,
  getMoleculeProgress,
  getStatusCatalog,
  getWorkspaceStatus,
  setCustomStatuses,
  updateStatus,
} from "../lib/bd"

const originalBdPath = process.env.BD_PATH
let root: string
let beadsDir: string
let argvPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-readonly-status-"))
  beadsDir = join(root, ".beads")
  argvPath = join(root, "argv")
  await mkdir(beadsDir)
  await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))
  const bdPath = join(root, "bd")
  await writeFile(
    bdPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "\${0%/*}/argv"
shift 2
case "$*" in
  "config get status.custom"*) echo 'review:active' ;;
  statuses*) echo '{"built_in_statuses":[{"name":"open"}],"custom_statuses":[{"name":"review"}]}' ;;
  types*) echo '{"core_types":["task"],"custom_types":[]}' ;;
  "epic status"*) echo '[]' ;;
  status*) echo '{"summary":{"total_issues":1}}' ;;
  "mol progress"*) echo '{"molecule_id":"test-123","total":1,"completed":0,"in_progress":0,"percent":0}' ;;
  "config set status.custom"*|"config unset status.custom"*|update*) echo '{}' ;;
  *) exit 13 ;;
esac
`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = bdPath
  __resetBdPathCache()
})

afterEach(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  __resetBdPathCache()
  if (root) await rm(root, { recursive: true, force: true })
})

async function expectReadFlags(command: string[]) {
  const argv = (await readFile(argvPath, "utf8")).trimEnd().split("\n")
  expect(argv.slice(0, 2)).toEqual(["--db", join(beadsDir, "dolt")])
  expect(argv.slice(2, 2 + command.length)).toEqual(command)
  expect(argv).toContain("--readonly")
  expect(argv).toContain("--sandbox")
}

// --sandbox suppresses auto-push on older supported bd versions where
// --readonly alone does not; keep both flags scoped to these reads.
test("getCustomStatusEntries passes both read flags", async () => {
  expect((await getCustomStatusEntries({ db: beadsDir })).map((entry) => entry.name)).toEqual([
    "review",
  ])
  await expectReadFlags(["config", "get", "status.custom"])
})

test("getStatusCatalog passes both read flags", async () => {
  expect(await getStatusCatalog({ db: beadsDir })).toEqual({
    builtIn: ["open"],
    custom: ["review"],
  })
  await expectReadFlags(["statuses"])
})

test("getAvailableTypes passes both read flags", async () => {
  expect(await getAvailableTypes({ db: beadsDir })).toEqual(["task"])
  await expectReadFlags(["types"])
})

test("getWorkspaceStatus passes both read flags", async () => {
  expect((await getWorkspaceStatus({ db: beadsDir })).total_issues).toBe(1)
  await expectReadFlags(["status"])
})

test("getEpicStatuses passes both read flags", async () => {
  expect(await getEpicStatuses({ db: beadsDir })).toEqual([])
  await expectReadFlags(["epic", "status"])
})

test("getMoleculeProgress passes both read flags", async () => {
  expect((await getMoleculeProgress("test-123", { db: beadsDir })).id).toBe("test-123")
  await expectReadFlags(["mol", "progress", "test-123"])
})

async function expectWriteFlags(command: string[]) {
  const argv = (await readFile(argvPath, "utf8")).trimEnd().split("\n")
  expect(argv).toEqual(["--db", join(beadsDir, "dolt"), ...command])
  expect(argv).not.toContain("--readonly")
  expect(argv).not.toContain("--sandbox")
}

test("setCustomStatuses set carries neither read flag", async () => {
  await setCustomStatuses(["review:active"], { db: beadsDir })
  await expectWriteFlags(["config", "set", "status.custom", "review:active"])
})

test("setCustomStatuses unset carries neither read flag", async () => {
  await setCustomStatuses([], { db: beadsDir })
  await expectWriteFlags(["config", "unset", "status.custom"])
})

test("updateStatus carries neither read flag", async () => {
  await updateStatus("test-123", "open", { db: beadsDir })
  await expectWriteFlags(["update", "test-123", "--status=open"])
})
