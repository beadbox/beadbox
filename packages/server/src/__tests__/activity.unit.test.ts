// Unit tests for the activity handler namespace.
//
// Strategy: spin up a fresh embedded-mode bd workspace in a tmpdir per test,
// invoke the handler, and assert the structured response shape. We do NOT
// stub bd — kkrpc handlers are thin wrappers over the bd CLI, and stubbing
// would defeat the parity contract with actions/activity.ts.
//
// Tests skip cleanly when bd is unavailable (CI without bd installed); the
// parity runner in P1.7 is the gating coverage for end-to-end behavior.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getActivityEvents, getActivityEventsSince, listBeadsByStatus } from "../handlers/activity"

// Every call here runs the real bd, which may start the workspace's Dolt
// server; on a loaded machine (load average 25-50) one call can exceed bun's
// 5 s default. The assertions are about the result, never the time taken, so
// a larger budget only bounds a hang. (File-scoped: other files keep 5 s.)
setDefaultTimeout(30_000)

let bdAvailable = true
try {
  execFileSync("bd", ["--version"], { stdio: "ignore" })
} catch {
  bdAvailable = false
}

// bb-yelc defense-in-depth: when these tests run under the husky pre-push
// hook, git injects GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE into the
// hook's env. They propagate to bun:test → execFileSync → bd → dolt →
// `git init --bare` and break with "GIT_WORK_TREE not allowed without
// GIT_DIR". The hook itself strips them (.husky/pre-push), but strip
// here too so the file is safe to run from any orchestrator (CI, IDE,
// `bun test ...` from a polluted shell, etc.).
const NO_GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
) as NodeJS.ProcessEnv

// Single shared workspace per file. The activity handlers are read-only on
// the workspace state, and `bd init` against a fresh tmpdir takes ~10s
// (bootstraps a Dolt instance), so beforeAll keeps the suite under 30s.
let workspaceDir: string
let dbPath: string

// Bun's beforeAll runtime accepts a timeout as the second argument but the
// pinned @types/bun (1.1.14) doesn't. Cast keeps strict TS happy without
// changing runtime behavior. The cast goes around the function call so it
// also covers the timeout arg.
const beforeAllT = beforeAll as unknown as (fn: () => unknown, timeoutMs?: number) => void

beforeAllT(async () => {
  if (!bdAvailable) return
  workspaceDir = await mkdtemp(join(tmpdir(), "bb-activity-test-"))
  // bd init runs `git commit` for the initial workspace state. On dev hosts
  // with commit.gpgsign=true that hangs forever waiting for gpg-agent.
  // Pre-initialize a tracker git repo with signing disabled so bd's commit
  // step is non-interactive. --skip-hooks avoids slow lint/test hook chains
  // a developer's global ~/.gitconfig might inject.
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.email=tests@beadbox.local",
      "-c",
      "user.name=beadbox-tests",
      "init",
      "-q",
    ],
    { cwd: workspaceDir, stdio: "ignore", env: NO_GIT_ENV },
  )
  execFileSync("bd", ["init", "--prefix", "test", "--non-interactive", "--skip-hooks"], {
    cwd: workspaceDir,
    stdio: "ignore",
    env: NO_GIT_ENV,
  })
  dbPath = join(workspaceDir, ".beads", "dolt")
}, 30_000)

afterAll(async () => {
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true })
  }
})

describe.skipIf(!bdAvailable)("activity handlers", () => {
  test("getActivityEvents returns empty events on a fresh workspace", async () => {
    const result = await getActivityEvents(dbPath)
    expect(result.error).toBeUndefined()
    expect(Array.isArray(result.events)).toBe(true)
    expect(result.events.length).toBe(0)
  })

  test("getActivityEvents respects custom limit", async () => {
    const result = await getActivityEvents(dbPath, 5)
    expect(result.error).toBeUndefined()
    expect(result.events.length).toBeLessThanOrEqual(5)
  })

  test("getActivityEventsSince returns empty when nothing happened in window", async () => {
    const result = await getActivityEventsSince(dbPath, "1h")
    expect(result.error).toBeUndefined()
    expect(Array.isArray(result.events)).toBe(true)
  })

  test("listBeadsByStatus returns empty bead list on a fresh workspace", async () => {
    const result = await listBeadsByStatus(dbPath)
    expect(result.error).toBeUndefined()
    expect(Array.isArray(result.beads)).toBe(true)
    expect(result.beads.length).toBe(0)
  })

  test("getActivityEvents emits structured error on bad db path", async () => {
    const result = await getActivityEvents("/nonexistent/path/.beads/dolt")
    // Error path: { events: [], error: <message> }. The exact message is
    // bd-version-dependent; just assert the shape and that something is set.
    expect(result.events).toEqual([])
    expect(typeof result.error === "string" && result.error.length > 0).toBe(true)
  })

  test("listBeadsByStatus emits structured error on bad db path", async () => {
    const result = await listBeadsByStatus("/nonexistent/path/.beads/dolt")
    expect(result.beads).toEqual([])
    expect(typeof result.error === "string" && result.error.length > 0).toBe(true)
  })
})
