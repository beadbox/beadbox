// Synthetic server-mode workspace for the serve-vs-CLI measurement
// (beadbox-6x2). DEV-ONLY: not in any build entrypoint, not run by CI or the
// pre-push hook. Deterministic from a seed; contains no real issue text.
//
// Cleanup ends everything the fixture started, including bd serve's
// per-workspace db-proxy-child (bd 1.3.x), and throws if anything survives.
//
// Shape (frozen on beadbox-6x2): 49% of issues have dependencies, ~6.5
// comments per issue, 10% epics with parent-child children, 40% closed.
// Text lengths are drawn from our own tracker's measured length quantiles
// (lengths only; the words are generated).

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Length quantiles (5% steps) measured from our tracker's export on 2026-09-25.
const LENGTHS = {
  title: [23, 50, 65, 70, 73, 80, 84, 86, 87, 89, 93, 96, 100, 103, 105, 108, 113, 117, 126, 135, 172],
  description: [
    0, 370, 847, 1205, 1441, 1496, 1654, 1752, 1874, 2022, 2171, 2264, 2423, 2607, 2689, 2798, 3047,
    3535, 3790, 4633, 5242,
  ],
  comment: [
    17, 180, 257, 343, 417, 521, 621, 772, 929, 1103, 1380, 1641, 1907, 2248, 2529, 2874, 3422, 3897,
    4493, 6072, 16237,
  ],
}
const WORDS =
  "the sidecar workspace server dolt query issue epic review fix test path lock token read write change detector bead status comment design plan note build release gate check census guard loop child shell detail tree list".split(
    " ",
  )

export const FIXTURE_PREFIX = "bench"

export interface Fixture {
  dir: string
  beadsDir: string
  ids: string[]
  cleanup: () => void
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function text(rand: () => number, quantiles: number[]): string {
  const i = Math.floor(rand() * (quantiles.length - 1))
  const len = Math.round(quantiles[i] + (quantiles[i + 1] - quantiles[i]) * rand())
  let s = ""
  while (s.length < len) s += `${WORDS[Math.floor(rand() * WORDS.length)]} `
  return s.slice(0, len).trim()
}

/** Where bd serve will agree to run: it refuses workspaces under a temp directory. */
function fixtureParent(): string {
  const base = process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache")
  mkdirSync(base, { recursive: true })
  return base
}

function bdEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.BEADS_DIR
  delete env.BEADS_DB
  return env
}

type Dep = { issue_id: string; depends_on_id: string; type: string }

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

// Draw order matters: the published S/L results came from this exact
// sequence of rand() calls, so each helper draws in the original order.
function issueDeps(rand: () => number, ids: string[], i: number, epicCount: number): Dep[] {
  const id = ids[i]
  const isEpic = i < epicCount
  const deps: Dep[] = []
  if (rand() >= 0.49) return deps
  if (!isEpic && epicCount > 0) {
    deps.push({ issue_id: id, depends_on_id: ids[Math.floor(rand() * epicCount)], type: "parent-child" })
  }
  if (i > 0 && (isEpic || rand() < 1 / 3)) {
    const target = ids[Math.floor(rand() * i)]
    if (!deps.some((d) => d.depends_on_id === target)) deps.push({ issue_id: id, depends_on_id: target, type: "blocks" })
  }
  return deps
}

function issueComments(rand: () => number, createdMs: number) {
  const count = Math.min(60, Math.floor(-Math.log(1 - rand()) * 6.5))
  return Array.from({ length: count }, (_, k) => ({
    author: "bench",
    text: text(rand, LENGTHS.comment) || "ok",
    created_at: stamp(createdMs + (k + 1) * 1000),
  }))
}

function issueRow(rand: () => number, ids: string[], i: number, epicCount: number, base: number): string {
  const id = ids[i]
  const createdMs = base + i * 60_000
  const created = stamp(createdMs)
  const dependencies = issueDeps(rand, ids, i, epicCount)
  const comments = issueComments(rand, createdMs)
  const closed = rand() < 0.4
  return JSON.stringify({
    id,
    title: text(rand, LENGTHS.title) || id,
    description: text(rand, LENGTHS.description),
    issue_type: i < epicCount ? "epic" : ["task", "bug", "feature", "chore"][Math.floor(rand() * 4)],
    priority: Math.floor(rand() * 5),
    status: closed ? "closed" : rand() < 0.2 ? "in_progress" : "open",
    created_at: created,
    updated_at: created,
    ...(closed ? { closed_at: created, close_reason: "done" } : {}),
    dependencies,
    comments,
  })
}

export function generateJsonl(size: number, seed: number): { lines: string[]; ids: string[] } {
  const rand = mulberry32(seed)
  const ids = Array.from({ length: size }, (_, i) => `${FIXTURE_PREFIX}-${i + 1}`)
  const epicCount = Math.round(size * 0.1)
  const base = Date.parse("2026-01-01T00:00:00Z")
  const lines = ids.map((_, i) => issueRow(rand, ids, i, epicCount, base))
  return { lines, ids }
}

/** Pids of bd db-proxy-child processes rooted in this fixture's Dolt directory. */
function proxyPids(beadsDir: string): number[] {
  const root = join(beadsDir, "dolt")
  const out = execFileSync("ps", ["-axww", "-o", "pid=,command="]).toString()
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.includes("db-proxy-child") && f[f.indexOf("--root") + 1] === root)
    .map((f) => Number(f[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function stopAndWait(pid: number): void {
  const wait = (ms: number) => {
    const until = Date.now() + ms
    while (alive(pid) && Date.now() < until) Bun.sleepSync(50)
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  wait(10_000)
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* gone */
    }
    wait(2_000)
  }
}

/** Build a bd-managed server-mode workspace of `size` issues with bd at `bd` (absolute path). */
export function makeFixture(bd: string, size: number, seed: number): Fixture {
  const dir = mkdtempSync(join(fixtureParent(), "beadbox-bench-"))
  const beadsDir = join(dir, ".beads")
  // Stop the fixture's Dolt server and WAIT for it to exit before removing the
  // directory: removing while it shuts down races its writes and leaves files
  // behind. Then verify the directory is gone, loudly.
  const cleanup = () => {
    const pidFile = join(beadsDir, "dolt-server.pid")
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf-8").trim())
      if (Number.isInteger(pid) && pid > 0) stopAndWait(pid)
    }
    if (!dir.includes("beadbox-bench-")) return
    // bd serve (1.3.x) starts a per-workspace db-proxy-child in its own
    // session, so it outlives both bd serve and the Dolt server. The fixture
    // is ours alone, so end every proxy rooted in it, and fail if one stays.
    for (const pid of proxyPids(beadsDir)) stopAndWait(pid)
    const left = proxyPids(beadsDir)
    if (left.length) throw new Error(`fixture cleanup failed: db-proxy-child still running (${left.join(", ")})`)
    for (let attempt = 0; attempt < 5 && existsSync(dir); attempt++) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
    if (existsSync(dir)) throw new Error(`fixture cleanup failed: ${dir} still exists`)
  }
  try {
    const run = (args: string[]) =>
      execFileSync(bd, args, { cwd: dir, env: bdEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 })
    execFileSync("git", ["init", "-q"], { cwd: dir })
    run(["init", "--server", "--prefix", FIXTURE_PREFIX, "--quiet", "--skip-agents", "--skip-hooks"])
    const { lines, ids } = generateJsonl(size, seed)
    const file = join(dir, "fixture.jsonl")
    writeFileSync(file, `${lines.join("\n")}\n`)
    run(["import", file])
    const count = JSON.parse(run(["count", "--json"]).toString()).count
    if (count !== size) throw new Error(`fixture has ${count} issues, expected ${size}`)
    return { dir, beadsDir, ids, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
