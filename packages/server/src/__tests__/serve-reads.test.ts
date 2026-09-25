// L4 wiring (beadbox-6x2): the real handlers, a temp registry, and a fake bd
// whose CLI answers are titled "from-cli" and whose `serve` answers are
// titled "from-serve", so each test can see which path answered.
//
//  - QAM: only a literal serveReads === true ever changes behaviour.
//  - sec: no read waits for a serve start.
//  - Any serve failure makes the read use the CLI; never an empty result.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBdPathCache } from "../lib/bd"
import { getCustomStatusList } from "../handlers/beads"
import { getBeadDetail, getEpics } from "../handlers/epics"
import { __resetServeReads, __serveReadsState, __settleServeStarts } from "../lib/serve-reads"
import { invalidateEpicCache } from "../lib/epic-cache"

const FAKE_SERVE = join(import.meta.dir, "fixtures", "fake-serve.ts")
const ID = "22222222-2222-4222-8222-222222222222"
const saved = { registry: process.env.BEADBOX_REGISTRY_PATH, bd: process.env.BD_PATH }
let root: string
let ws: string
let beadsDir: string
let log: string

function fakeBd(): string {
  const path = join(root, "bd")
  const cliRow = (id: string) => `{"id":"${id}","title":"from-cli ${id}","status":"open","priority":2,"issue_type":"task"}`
  writeFileSync(
    path,
    `#!/bin/sh
[ "$1" = "--db" ] && shift 2
printf '%s\\n' "$1" >> '${log}'
case "$1" in
  --version) echo "bd version 1.3.0 (fake)" ;;
  serve) exec '${process.execPath}' '${FAKE_SERVE}' "$@" ;;
  sql) echo '[{"h":"x","i":"2026-01-01","c":0}]' ;;
  list) echo '[${cliRow("w-1")},${cliRow("w-2")}]' ;;
  show) echo '[${cliRow("w-1")}]' ;;
  comments) echo '[{"id":"c9","issue_id":"w-1","author":"a","text":"cli comment","created_at":"2026-01-01T00:00:00Z"}]' ;;
  dep) echo '[]' ;;
  config) echo 'cli-a,cli-b' ;;
  *) echo '[]' ;;
esac
`,
  )
  chmodSync(path, 0o755)
  return path
}

function registry(serveReads: unknown): void {
  const entry: Record<string, unknown> = {
    id: ID,
    name: "fake",
    addedAt: "2026-09-25T00:00:00.000Z",
    local: { path: beadsDir },
    server: null,
    mode: "server",
  }
  if (serveReads !== "<absent>") entry.serveReads = serveReads
  writeFileSync(process.env.BEADBOX_REGISTRY_PATH as string, JSON.stringify({ version: 2, activeWorkspace: ID, workspaces: [entry] }))
}

const serveSpawns = () => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter((l) => l === "serve").length : 0)
const mode = (m: string) => writeFileSync(join(ws, "fake-serve-mode"), m)

async function warm(): Promise<void> {
  // First eligible read starts serve in the background and is answered by the CLI.
  await getCustomStatusList(beadsDir)
  await __settleServeStarts()
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "beadbox-serve-reads-"))
  ws = join(root, "ws")
  beadsDir = join(ws, ".beads")
  mkdirSync(beadsDir, { recursive: true })
  writeFileSync(join(beadsDir, "metadata.json"), JSON.stringify({ backend: "dolt", dolt_mode: "server", dolt_database: "fake" }))
  log = join(root, "bd.log")
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
  process.env.BD_PATH = fakeBd()
  __resetBdPathCache()
  await __resetServeReads()
  invalidateEpicCache()
})

afterEach(async () => {
  await __resetServeReads()
  invalidateEpicCache()
  if (saved.registry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = saved.registry
  if (saved.bd === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = saved.bd
  __resetBdPathCache()
  rmSync(root, { recursive: true, force: true })
})

describe("QAM: only a literal true changes behaviour, through the real handlers", () => {
  for (const value of ["<absent>", false, "true", 1, {}, "yes", null]) {
    test(`serveReads = ${JSON.stringify(value)}: CLI answers, nothing spawned, no manager`, async () => {
      registry(value)
      for (let i = 0; i < 3; i++) {
        expect(await getCustomStatusList(beadsDir)).toEqual(["cli-a", "cli-b"])
        expect((await getBeadDetail("w-1", beadsDir))?.title).toBe("from-cli w-1")
      }
      await __settleServeStarts()
      expect(serveSpawns()).toBe(0)
      expect(__serveReadsState().managerConstructed).toBe(false)
    })
  }

  test("serveReads = true: serve starts, and later reads come from serve", async () => {
    registry(true)
    await warm()
    expect(serveSpawns()).toBe(1)
    expect(await getCustomStatusList(beadsDir)).toEqual(["serve-a", "serve-b"])
    const detail = await getBeadDetail("w-1", beadsDir)
    expect(detail?.title).toBe("from-serve w-1")
    expect(detail?.comments.map((c) => c.content)).toEqual(["serve comment"])
  })
})

describe("sec: no read waits for a serve start", () => {
  test("a slow serve start never delays a read; the CLI answers until serve is ready", async () => {
    registry(true)
    mode("slow-start") // the fake prints its listening line after 1.5 s
    const t0 = performance.now()
    expect(await getCustomStatusList(beadsDir)).toEqual(["cli-a", "cli-b"])
    expect(await getCustomStatusList(beadsDir)).toEqual(["cli-a", "cli-b"])
    expect(performance.now() - t0).toBeLessThan(1000)
    await __settleServeStarts()
    expect(await getCustomStatusList(beadsDir)).toEqual(["serve-a", "serve-b"])
  })
})

describe("any serve failure reads through the CLI, never empty", () => {
  const cases: Array<[string, boolean]> = [
    ["garbage", false], // contract -> integrity: serve disabled
    ["503", false], // transient: serve kept, retried later
    ["incomplete", false], // this read only
  ]
  for (const [m] of cases) {
    test(`serve answers '${m}': the detail comes from the CLI, complete`, async () => {
      registry(true)
      await warm()
      mode(m)
      const detail = await getBeadDetail("w-1", beadsDir)
      expect(detail?.title).toBe("from-cli w-1")
      expect(detail?.comments.map((c) => c.content)).toEqual(["cli comment"])
    })
  }

  test("an integrity failure disables serve for the workspace (no more serve attempts)", async () => {
    registry(true)
    await warm()
    mode("garbage")
    expect(await getCustomStatusList(beadsDir)).toEqual(["cli-a", "cli-b"])
    mode("normal")
    await __settleServeStarts()
    expect(await getCustomStatusList(beadsDir)).toEqual(["cli-a", "cli-b"])
    expect([...__serveReadsState().workspaces.values()][0]?.disabled).toBeTruthy()
    expect(serveSpawns()).toBe(1)
  })

  test("a transient failure keeps serve: a later read reconnects", async () => {
    registry(true)
    await warm()
    mode("503")
    expect(await getCustomStatusList(beadsDir)).toEqual(["cli-a", "cli-b"])
    mode("normal")
    await getCustomStatusList(beadsDir) // reconnects in the background, answered by the CLI
    await __settleServeStarts()
    expect(await getCustomStatusList(beadsDir)).toEqual(["serve-a", "serve-b"])
  })

  test("a server that answers for another workspace is never trusted", async () => {
    registry(true)
    mode("identity")
    await warm()
    expect(await getCustomStatusList(beadsDir)).toEqual(["cli-a", "cli-b"])
    expect((await getBeadDetail("w-1", beadsDir))?.title).toBe("from-cli w-1")
    expect([...__serveReadsState().workspaces.values()][0]?.disabled).toContain("not this workspace")
  })

  test("the child killed mid-session: the next read is the CLI's, then serve recovers", async () => {
    registry(true)
    await warm()
    const pid = Number(readFileSync(join(ws, "fake-serve.pid"), "utf-8"))
    process.kill(pid, "SIGKILL")
    await Bun.sleep(200)
    expect(await getCustomStatusList(beadsDir)).toEqual(["cli-a", "cli-b"])
    await getCustomStatusList(beadsDir)
    await __settleServeStarts()
    expect(await getCustomStatusList(beadsDir)).toEqual(["serve-a", "serve-b"])
  })
})

test("the tree: the plain list may come from serve; the system-inclusive list never does", async () => {
  registry(true)
  await warm()
  const plain = await getEpics(beadsDir)
  expect(JSON.stringify(plain)).toContain("from-serve")
  invalidateEpicCache()
  const withSystem = await getEpics(beadsDir, true)
  expect(JSON.stringify(withSystem)).not.toContain("from-serve")
})
