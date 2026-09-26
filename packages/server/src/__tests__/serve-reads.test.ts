// L4 wiring (beadbox-6x2): the real handlers, a temp registry, and a fake bd
// whose CLI answers are titled "from-cli" and whose `serve` answers are
// titled "from-serve", so each test can see which path answered.
//
//  - QAM: only a literal serveReads === true ever changes behaviour.
//  - sec: no read waits for a serve start.
//  - Any serve failure makes the read use the CLI; never an empty result.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBdPathCache } from "../lib/bd"
import { getCustomStatusList } from "../handlers/beads"
import { getBeadDetail, getBlocksDependencies, getEpics } from "../handlers/epics"
import { __resetServeReads, __serveReadsState, __settleServeStarts } from "../lib/serve-reads"
import { invalidateEpicCache } from "../lib/epic-cache"

// Load-robust, not load-dependent: every assertion here is about WHICH path
// answered and what it returned, never about how long it took. A test starts
// a real child (the fake serve) and a stop reaps it, which on a machine at a
// load average of 25-50 can take well over bun's 5 s default; the budgets
// below only bound a hang.
const TEST_BUDGET_MS = 30_000
const HOOK_BUDGET_MS = 30_000
setDefaultTimeout(TEST_BUDGET_MS)
// Bun's hooks accept a timeout at runtime; the pinned types don't.
const beforeEachT = beforeEach as unknown as (fn: () => unknown, timeoutMs?: number) => void
const afterEachT = afterEach as unknown as (fn: () => unknown, timeoutMs?: number) => void

const FAKE_SERVE = join(import.meta.dir, "fixtures", "fake-serve.ts")
const ID = "22222222-2222-4222-8222-222222222222"
const saved = { registry: process.env.BEADBOX_REGISTRY_PATH, bd: process.env.BD_PATH }
let root: string
let ws: string
let beadsDir: string
let log: string

function fakeBd(): string {
  const path = join(root, "bd")
  const cliRow = (id: string, count = 0, blocker = "") =>
    `{"id":"${id}","title":"from-cli ${id}","status":"open","priority":2,"issue_type":"task","dependency_count":${count}${blocker ? `,"dependencies":[{"issue_id":"${id}","depends_on_id":"${blocker}","type":"blocks"}]` : ""}}`
  writeFileSync(
    path,
    `#!/bin/sh
[ "$1" = "--db" ] && shift 2
printf '%s\\n' "$1" >> '${log}'
case "$1" in
  --version) echo "bd version 1.3.0 (fake)" ;;
  serve) exec '${process.execPath}' '${FAKE_SERVE}' "$@" ;;
  sql) echo '[{"h":"x","i":"2026-01-01","c":0}]' ;;
  list) echo '[${cliRow("w-1", 0)},${cliRow("w-2", 1, "w-1")}]' ;;
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const serveSpawns = () => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter((l) => l === "serve").length : 0)
const mode = (m: string) => writeFileSync(join(ws, "fake-serve-mode"), m)

async function warm(): Promise<void> {
  // First eligible read starts serve in the background and is answered by the CLI.
  await getCustomStatusList(beadsDir)
  await __settleServeStarts()
}

beforeEachT(async () => {
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
}, HOOK_BUDGET_MS)

afterEachT(async () => {
  await __resetServeReads()
  invalidateEpicCache()
  if (saved.registry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = saved.registry
  if (saved.bd === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = saved.bd
  __resetBdPathCache()
  rmSync(root, { recursive: true, force: true })
}, HOOK_BUDGET_MS)

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
    // Serve cannot become ready until the test says so. Reads that return
    // while it is held provably did not wait for it: no wall-clock bound, so
    // a loaded machine can't fail this and a fast one can't pass it by luck.
    mode("gated-start")
    const release = join(ws, "fake-serve-release")
    const reads = (async () => [await getCustomStatusList(beadsDir), await getCustomStatusList(beadsDir)])()
    const outcome = await Promise.race([reads, Bun.sleep(TEST_BUDGET_MS / 2).then(() => "a read waited for serve")])
    expect(outcome).toEqual([
      ["cli-a", "cli-b"],
      ["cli-a", "cli-b"],
    ])
    expect(existsSync(release)).toBe(false) // serve was never allowed to be ready
    const state = [...__serveReadsState().workspaces.values()][0]
    expect(state?.client).toBeFalsy()
    // The decisive check, and not a clock: the start is STILL in progress when
    // both reads have answered. A read that waited for the start could only
    // have answered after the start ended (here, only by failing).
    expect(state?.starting).toBeTruthy()
    writeFileSync(release, "")
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
    // Wait until the child is really gone (a fixed sleep is a guess under load).
    for (let i = 0; i < 200 && alive(pid); i++) await Bun.sleep(50)
    expect(alive(pid)).toBe(false)
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

describe("sec B1: blocked-by through serve never becomes 'no blockers'", () => {
  test("serve rows with complete dependency data: the tree and blocked-by come from serve", async () => {
    registry(true)
    await warm()
    const tree = await getEpics(beadsDir)
    expect(JSON.stringify(tree)).toContain("from-serve")
    expect((await getBlocksDependencies(beadsDir)).blockedBy).toEqual({ "w-2": ["w-1"] })
  })

  test("serve rows with the blocking edges stripped: the tree load reads through the CLI, blocked-by intact", async () => {
    registry(true)
    await warm()
    mode("deps-stripped")
    invalidateEpicCache()
    const tree = await getEpics(beadsDir)
    expect((await getBlocksDependencies(beadsDir)).blockedBy).toEqual({ "w-2": ["w-1"] }) // never {}
    expect(JSON.stringify(tree)).not.toContain("from-serve") // the incomplete serve list was not used
  })
})
