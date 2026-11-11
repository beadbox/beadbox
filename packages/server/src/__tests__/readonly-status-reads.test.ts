import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBdPathCache, getCustomStatusEntries, getStatusCatalog } from "../lib/bd"

const originalBdPath = process.env.BD_PATH
let root: string | undefined

afterEach(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  __resetBdPathCache()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

// bd runs its post-command maintenance (auto-commit, auto-backup, dolt auto-push) after
// every command it does not classify as read-only, and `config get` and `statuses` are
// not on that list. Beadbox calls both on every change, in parallel, so without
// --readonly each call could start its own auto-push and race the writer's push.
test("status reads pass --readonly so they never trigger bd's auto-push", async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-readonly-status-"))
  const beadsDir = join(root, ".beads")
  await mkdir(beadsDir)
  await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))
  const bdPath = join(root, "bd")
  await writeFile(
    bdPath,
    `#!/bin/sh
case " $* " in *" --readonly "*) ;; *) exit 12 ;; esac
case "$*" in
  *"config get status.custom"*) echo 'review:active' ;;
  *" statuses"*) echo '{"built_in_statuses":[{"name":"open"}],"custom_statuses":[{"name":"review"}]}' ;;
  *) exit 13 ;;
esac
`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = bdPath
  __resetBdPathCache()

  expect((await getCustomStatusEntries({ db: beadsDir })).map((entry) => entry.name)).toEqual([
    "review",
  ])
  expect(await getStatusCatalog({ db: beadsDir })).toEqual({
    builtIn: ["open"],
    custom: ["review"],
  })
})
