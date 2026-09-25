// Serve-vs-CLI read latency, run to the protocol FROZEN on beadbox-6x2 before
// any measurement. DEV-ONLY: not in any build entrypoint or package "files",
// not run by CI or the pre-push hook. It starts `bd serve` only while it runs,
// bound to 127.0.0.1:0, with a fresh token in a 0700 dir / 0600 file, and
// removes the child, the token and the synthetic workspace on every exit path.
//
//   bun bench/serve-vs-cli.ts --bd /abs/path/to/bd --size 500 [--runs 10] [--seed 42] --out result.json
//
// A session = 1 tree load, 20 detail opens, 10 tree reloads (each after an
// untimed write), 1 status.custom read. The serve session pays spawn +
// listening line + ready + context handshake on the critical path before any
// read counts. Sessions are interleaved CLI/serve, after one discarded warm-up
// of each. Published output contains timings, counts and match booleans only.

import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  __resetBdPathCache,
  getComments,
  getCustomStatuses,
  getDataFingerprint,
  listBeads,
  listDependencies,
  listDependents,
  showBead,
} from "../src/lib/bd"
import { serveReadEligibility } from "../src/lib/serve-eligibility"
import { type Fixture, makeFixture } from "./fixture"

// ---------------------------------------------------------------------------
// Frozen protocol constants (beadbox-6x2). Changing any of these is a new
// protocol, not a re-run.
const DETAIL_OPENS = 20
const RELOADS = 10
const P1_MEDIAN_RATIO = 0.67
const P2_WORST_RATIO = 0.8
const P3_ABS_MS_AT_L = 100
const L_SIZE = 5000
// ---------------------------------------------------------------------------

type Args = { bd: string; size: number; runs: number; seed: number; out: string; cliListMaxBuffer: number | null }

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const bd = get("bd")
  const out = get("out")
  if (!bd?.startsWith("/")) throw new Error("--bd must be an absolute path (sec A3)")
  if (!out) throw new Error("--out is required")
  return {
    bd,
    out,
    size: Number(get("size") ?? 500),
    runs: Number(get("runs") ?? 10),
    seed: Number(get("seed") ?? 42),
    cliListMaxBuffer: get("cli-list-max-buffer") ? Number(get("cli-list-max-buffer")) : null,
  }
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const p95 = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]
}
const ms = (t0: number) => performance.now() - t0
const idSet = (xs: Array<{ id: string }> | null | undefined) => [...new Set((xs ?? []).map((x) => x.id))].sort()
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// What a session observed, for P4. Kept in memory only; never written out.
interface Observed {
  tree: string[][]
  detail: Array<{ comments: number; deps: string[]; dependents: string[] }>
  config: string[]
}

interface SessionTiming {
  path: "cli" | "serve"
  run: number
  startup_ms: number
  tree_ms: number[] // initial load + each reload
  detail_ms: number[]
  config_ms: number
  total_ms: number
  error: string | null
}

// ---------------------------------------------------------------------------
// bd serve (sec's L2 token hygiene, applied to the harness)

interface Serve {
  url: string
  token: string
  child: ChildProcess
  tokenDir: string
}

let live: Serve | null = null
let fixture: Fixture | null = null

function stopServe(): void {
  if (!live) return
  const { child, tokenDir } = live
  live = null
  try {
    child.kill("SIGTERM")
  } catch {
    /* gone */
  }
  if (tokenDir.includes("beadbox-serve-")) rmSync(tokenDir, { recursive: true, force: true })
}

function cleanupAll(): void {
  stopServe()
  fixture?.cleanup()
  fixture = null
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanupAll()
    process.exit(130)
  })
}

async function startServe(bd: string, dir: string): Promise<Serve> {
  const tokenDir = mkdtempSync(join(tmpdir(), "beadbox-serve-"))
  // mkdtemp creates 0700 already; set it explicitly anyway.
  execFileSync("chmod", ["700", tokenDir])
  const token = randomBytes(32).toString("base64url")
  const tokenFile = join(tokenDir, "token")
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" })
  const env = { ...process.env }
  delete env.BEADS_DIR
  delete env.BEADS_DB
  const child = spawn(bd, ["serve", "--addr", "127.0.0.1:0", "--auth-token-file", tokenFile], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  live = { url: "", token, child, tokenDir }
  const url = await new Promise<string>((resolve, reject) => {
    let buf = ""
    const timer = setTimeout(() => reject(new Error("bd serve: no listening line within 30s")), 30_000)
    child.on("exit", (code) => reject(new Error(`bd serve exited (${code}) before listening`)))
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString()
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      clearTimeout(timer)
      // Strict (sec C1): exactly one line naming a loopback address.
      const m = /^bd serve: listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(buf.slice(0, nl))
      if (m) resolve(m[1])
      else reject(new Error("bd serve: unexpected first stdout line"))
    })
  })
  live.url = url
  return live
}

async function get<T>(s: Serve, path: string): Promise<T> {
  const res = await fetch(`${s.url}${path}`, {
    headers: { Authorization: `Bearer ${s.token}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`serve ${path.split("?")[0]} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

async function handshake(s: Serve, beadsDir: string): Promise<void> {
  const deadline = performance.now() + 30_000
  for (;;) {
    const res = await fetch(`${s.url}/v0/beads/ready?limit=1`, {
      headers: { Authorization: `Bearer ${s.token}` },
    }).catch(() => null)
    if (res?.ok) break
    if (performance.now() > deadline) throw new Error("bd serve: not ready within 30s")
    await new Promise((r) => setTimeout(r, 25))
  }
  const ctx = await get<Record<string, unknown>>(s, "/v0/beads/context")
  // Identity: fields REQUIRED (sec, design (d)); absence is a failure.
  if (ctx.api_version !== "v0") throw new Error("context: api_version")
  if (typeof ctx.bd_version !== "string" || !/^1\.(3|[4-9]|\d{2,})\./.test(ctx.bd_version)) {
    throw new Error("context: bd_version")
  }
  if (typeof ctx.beads_dir !== "string" || realpathSync(ctx.beads_dir) !== realpathSync(beadsDir)) {
    throw new Error("context: beads_dir is not this workspace")
  }
  if (typeof ctx.database !== "string" || !ctx.database) throw new Error("context: database")
}

// The row-shape validation L3 would ship: the fields the CLI path's types assume.
function validRow(x: unknown): boolean {
  const r = x as Record<string, unknown>
  return (
    !!r &&
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.status === "string" &&
    typeof r.priority === "number" &&
    typeof r.issue_type === "string"
  )
}

async function serveList(s: Serve): Promise<string[]> {
  const params = new URLSearchParams({ sort: "priority", all: "true", limit: "0" })
  const items: unknown[] = []
  for (;;) {
    const page = await get<{ items: unknown[]; has_more: boolean; next_cursor?: string }>(
      s,
      `/v0/beads/issues?${params}`,
    )
    if (!Array.isArray(page.items)) throw new Error("serve list: items")
    items.push(...page.items)
    if (!page.has_more) break
    if (!page.next_cursor) throw new Error("serve list: pagination")
    params.set("cursor", page.next_cursor)
  }
  if (!items.every(validRow)) throw new Error("serve list: malformed row")
  return idSet(items as Array<{ id: string }>)
}

async function serveDetail(s: Serve, id: string) {
  const d = await get<Record<string, unknown>>(
    s,
    `/v0/beads/issues/${encodeURIComponent(id)}?include_comments=true&include_dependents=true`,
  )
  if (!validRow(d)) throw new Error("serve detail: malformed")
  const count = d.comment_count
  if (typeof count !== "number") throw new Error("serve detail: comment_count missing")
  if (count > 0 && !Array.isArray(d.comments)) throw new Error("serve detail: comments missing")
  return {
    comments: Array.isArray(d.comments) ? d.comments.length : 0,
    deps: idSet(d.dependencies as Array<{ id: string }>),
    dependents: idSet(d.dependents as Array<{ id: string }>),
  }
}

// ---------------------------------------------------------------------------
// CLI list above the shipped 10 MB stdout cap (beadbox-6x2 ruling (a), L only)
//
// At 5,000 issues the tree list is 13.6 MB and the shipped lib/bd.ts caps bd's
// stdout at 10 MB, so the real listBeads FAILS (beadbox-uk2). Ruling (a): the
// raise lives ONLY here; lib/bd.ts is untouched. With --cli-list-max-buffer,
// the CLI side's tree list runs the SAME bd argv, cwd and env var the real
// listBeads runs, with this stated ceiling instead of 10 MB. "Same" is checked,
// not assumed: before any run the real listBeads is executed against a
// recording shim and its argv must equal the wrapper's.
const CLI_LIST_CEILING_BYTES = 32 * 1024 * 1024 // 32 MiB: 2.35x the measured 13.6 MB

const execFileAsync = promisify(execFile)

function wrapperListArgv(f: Fixture): { argv: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const port = readFileSync(join(f.beadsDir, "dolt-server.port"), "utf-8").trim()
  return {
    argv: ["--db", join(f.beadsDir, "dolt"), "list", "--status", "all", "--limit", "0", "--flat", "--json"],
    cwd: f.dir,
    env: { ...process.env, BEADS_DOLT_SERVER_PORT: port },
  }
}

async function wrapperListBeads(a: Args, f: Fixture): Promise<Array<{ id: string; status: string; issue_type: string }>> {
  const { argv, cwd, env } = wrapperListArgv(f)
  const { stdout } = await execFileAsync(a.bd, argv, { cwd, env, maxBuffer: a.cliListMaxBuffer ?? 0, timeout: 30_000 })
  return JSON.parse(stdout)
}

/** Run the REAL listBeads against a shim that records its argv; require the wrapper to match. */
async function assertWrapperMatchesRealListBeads(a: Args, f: Fixture): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "beadbox-bench-shim-"))
  try {
    const log = join(dir, "argv")
    const shim = join(dir, "bd")
    writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$BEADS_DOLT_SERVER_PORT" "$@" > "${log}"\necho '[]'\n`)
    chmodSync(shim, 0o700)
    process.env.BD_PATH = shim
    __resetBdPathCache()
    await listBeads({ db: f.beadsDir, parallel: true })
    const [pwd, port, ...argv] = readFileSync(log, "utf-8").trimEnd().split("\n")
    const w = wrapperListArgv(f)
    if (JSON.stringify(argv) !== JSON.stringify(w.argv) || realpathSync(pwd) !== realpathSync(w.cwd) || port !== w.env.BEADS_DOLT_SERVER_PORT) {
      throw new Error(`wrapper argv/cwd/env differs from the real listBeads: ${JSON.stringify({ argv, pwd, port })}`)
    }
  } finally {
    process.env.BD_PATH = a.bd
    __resetBdPathCache()
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Sessions

interface Plan {
  details: string[]
  writes: string[]
}

function write(bd: string, dir: string, id: string, status: string): void {
  execFileSync(bd, ["update", id, "--status", status], { cwd: dir, stdio: "ignore" })
}

async function cliSession(a: Args, f: Fixture, plan: Plan, run: number, obs: Observed): Promise<SessionTiming> {
  const opts = { db: f.beadsDir, parallel: true }
  const t: SessionTiming = { path: "cli", run, startup_ms: 0, tree_ms: [], detail_ms: [], config_ms: 0, total_ms: 0, error: null }
  const tree = async () => {
    const t0 = performance.now()
    await getDataFingerprint(opts)
    const rows = a.cliListMaxBuffer ? await wrapperListBeads(a, f) : await listBeads(opts)
    t.tree_ms.push(ms(t0))
    obs.tree.push(idSet(rows))
  }
  try {
    await tree()
    for (const id of plan.details) {
      const t0 = performance.now()
      const [, comments, deps, dependents] = await Promise.all([
        showBead(id, opts),
        getComments(id, opts),
        listDependencies(id, opts),
        listDependents(id, opts),
      ])
      t.detail_ms.push(ms(t0))
      obs.detail.push({ comments: comments.length, deps: idSet(deps), dependents: idSet(dependents) })
    }
    for (const id of plan.writes) {
      write(a.bd, f.dir, id, "in_progress")
      await tree()
    }
    const t0 = performance.now()
    obs.config = await getCustomStatuses(opts)
    t.config_ms = ms(t0)
  } catch (e) {
    t.error = e instanceof Error ? e.message : String(e)
  } finally {
    for (const id of plan.writes) write(a.bd, f.dir, id, "open")
  }
  t.total_ms = t.tree_ms.reduce((x, y) => x + y, 0) + t.detail_ms.reduce((x, y) => x + y, 0) + t.config_ms
  return t
}

async function serveSession(a: Args, f: Fixture, plan: Plan, run: number, obs: Observed): Promise<SessionTiming> {
  const opts = { db: f.beadsDir, parallel: true }
  const t: SessionTiming = { path: "serve", run, startup_ms: 0, tree_ms: [], detail_ms: [], config_ms: 0, total_ms: 0, error: null }
  try {
    const t0 = performance.now()
    const s = await startServe(a.bd, f.dir)
    await handshake(s, f.beadsDir)
    t.startup_ms = ms(t0)
    const tree = async () => {
      const t1 = performance.now()
      // The fingerprint stays on its existing path in the design; paid on both sides.
      await getDataFingerprint(opts)
      const ids = await serveList(s)
      t.tree_ms.push(ms(t1))
      obs.tree.push(ids)
    }
    await tree()
    for (const id of plan.details) {
      const t1 = performance.now()
      obs.detail.push(await serveDetail(s, id))
      t.detail_ms.push(ms(t1))
    }
    for (const id of plan.writes) {
      write(a.bd, f.dir, id, "in_progress")
      await tree()
    }
    const t1 = performance.now()
    const c = await get<{ value?: unknown }>(s, "/v0/beads/config/status.custom")
    t.config_ms = ms(t1)
    obs.config =
      typeof c.value === "string" && c.value.trim()
        ? c.value.split(",").map((x) => x.trim()).filter(Boolean)
        : []
  } catch (e) {
    t.error = e instanceof Error ? e.message : String(e)
  } finally {
    stopServe()
    for (const id of plan.writes) write(a.bd, f.dir, id, "open")
  }
  t.total_ms =
    t.startup_ms + t.tree_ms.reduce((x, y) => x + y, 0) + t.detail_ms.reduce((x, y) => x + y, 0) + t.config_ms
  return t
}

const examined = { tree_reads: 0, tree_ids: 0, details: 0, details_with_comments: 0, details_with_deps: 0 }

function compare(cli: Observed, serve: Observed): string[] {
  const bad: string[] = []
  examined.tree_reads += cli.tree.length
  examined.tree_ids += cli.tree.reduce((n, ids) => n + ids.length, 0)
  examined.details += cli.detail.length
  examined.details_with_comments += cli.detail.filter((d) => d.comments > 0).length
  examined.details_with_deps += cli.detail.filter((d) => d.deps.length + d.dependents.length > 0).length
  if (cli.tree.length !== serve.tree.length) bad.push("tree read count")
  cli.tree.forEach((ids, i) => {
    if (!serve.tree[i] || !same(ids, serve.tree[i])) bad.push(`tree ${i}: id set`)
  })
  cli.detail.forEach((d, i) => {
    const s = serve.detail[i]
    if (!s) return bad.push(`detail ${i}: missing`)
    if (d.comments !== s.comments) bad.push(`detail ${i}: comments ${d.comments} vs ${s.comments}`)
    if (!same(d.deps, s.deps)) bad.push(`detail ${i}: dependency set`)
    if (!same(d.dependents, s.dependents)) bad.push(`detail ${i}: dependent set`)
  })
  if (!same([...cli.config].sort(), [...serve.config].sort())) bad.push("config")
  return bad
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2))
  const sha256 = createHash("sha256").update(readFileSync(a.bd)).digest("hex")
  const bdVersion = execFileSync(a.bd, ["--version"]).toString().trim()
  const doltVersion = execFileSync("dolt", ["version"]).toString().split("\n")[0].trim()
  const machine = execFileSync("sysctl", ["-n", "hw.model"]).toString().trim()
  const eligibility = serveReadEligibility(
    { serveReads: true, mode: "server", local: { path: "fixture" } },
    { platform: process.platform, bdVersion },
  )
  if (!eligibility.eligible) throw new Error(`not eligible: ${eligibility.reason} ${eligibility.detail ?? ""}`)

  process.env.BD_PATH = a.bd
  __resetBdPathCache()

  console.error(`[bench] building ${a.size}-issue fixture (seed ${a.seed})...`)
  fixture = makeFixture(a.bd, a.size, a.seed)
  const f = fixture
  // Deterministic session plan: detail targets spread across the id space;
  // write targets are open, non-epic issues (restored to open after each session).
  const rand = (() => {
    let x = a.seed ^ 0x9e3779b9
    return () => {
      x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0
      return x / 4294967296
    }
  })()
  // Condition (3): record what the SHIPPED CLI path does at this size.
  let shippedCliList = "ok"
  try {
    await listBeads({ db: f.beadsDir, parallel: true })
  } catch (e) {
    shippedCliList = `FAILS: ${e instanceof Error ? e.message : String(e)}`
  }
  console.error(`[bench] shipped listBeads at ${a.size}: ${shippedCliList}`)
  if (a.cliListMaxBuffer !== null) {
    if (a.cliListMaxBuffer !== CLI_LIST_CEILING_BYTES) {
      throw new Error(`--cli-list-max-buffer must be the declared ceiling ${CLI_LIST_CEILING_BYTES}`)
    }
    await assertWrapperMatchesRealListBeads(a, f)
    console.error(`[bench] CLI tree list via wrapper, ceiling ${CLI_LIST_CEILING_BYTES} bytes (argv verified = real listBeads)`)
  }
  const openRows = (
    a.cliListMaxBuffer ? await wrapperListBeads(a, f) : await listBeads({ db: f.beadsDir, parallel: true })
  ).filter(
    (r) => r.status === "open" && r.issue_type !== "epic",
  )
  const pick = <T>(xs: T[], n: number) => {
    const c = [...xs]
    const out: T[] = []
    while (out.length < n && c.length) out.push(c.splice(Math.floor(rand() * c.length), 1)[0])
    return out
  }
  const plan: Plan = { details: pick(f.ids, DETAIL_OPENS), writes: pick(openRows.map((r) => r.id), RELOADS) }

  const sessions: SessionTiming[] = []
  const pairs: Array<{ run: number; ratio: number | null; failed: string[] }> = []
  try {
    console.error("[bench] warm-up (discarded)...")
    await cliSession(a, f, plan, 0, { tree: [], detail: [], config: [] })
    await serveSession(a, f, plan, 0, { tree: [], detail: [], config: [] })
    for (let run = 1; run <= a.runs; run++) {
      const oc: Observed = { tree: [], detail: [], config: [] }
      const os: Observed = { tree: [], detail: [], config: [] }
      const c = await cliSession(a, f, plan, run, oc)
      const s = await serveSession(a, f, plan, run, os)
      sessions.push(c, s)
      const failed = [
        ...(c.error ? [`cli error: ${c.error}`] : []),
        ...(s.error ? [`serve error: ${s.error}`] : []),
        ...(c.error || s.error ? [] : compare(oc, os)),
      ]
      pairs.push({ run, ratio: failed.length ? null : s.total_ms / c.total_ms, failed })
      console.error(
        `[bench] run ${run}/${a.runs}: cli ${c.total_ms.toFixed(0)}ms serve ${s.total_ms.toFixed(0)}ms` +
          (failed.length ? ` FAILED (${failed.length})` : ` ratio ${(s.total_ms / c.total_ms).toFixed(3)}`),
      )
    }
  } finally {
    cleanupAll()
  }

  // ---- Verdict against the frozen P1-P4 ----
  const cli = sessions.filter((x) => x.path === "cli")
  const srv = sessions.filter((x) => x.path === "serve")
  const ratios = pairs.map((p) => p.ratio).filter((r): r is number => r !== null)
  const failedRuns = pairs.filter((p) => p.failed.length)
  const pool = (xs: SessionTiming[], k: "tree_ms" | "detail_ms") => xs.flatMap((x) => x[k])
  const isL = a.size >= L_SIZE
  const p3 = (k: "tree_ms" | "detail_ms") => {
    const c = pool(cli, k)
    const s = pool(srv, k)
    const medOk = isL ? median(s) <= median(c) - P3_ABS_MS_AT_L : median(s) <= median(c)
    return { cli_median: median(c), cli_p95: p95(c), serve_median: median(s), serve_p95: p95(s), pass: medOk && p95(s) <= p95(c) }
  }
  const P1 = ratios.length === a.runs && median(ratios) <= P1_MEDIAN_RATIO
  const P2 = ratios.length === a.runs && Math.max(...ratios) <= P2_WORST_RATIO
  const tree = p3("tree_ms")
  const detail = p3("detail_ms")
  const P3 = tree.pass && detail.pass
  // A correctness check that examined nothing is not a pass.
  const P4 =
    failedRuns.length === 0 &&
    examined.tree_ids > 0 &&
    examined.details_with_comments > 0 &&
    examined.details_with_deps > 0
  const totals = (xs: SessionTiming[]) => xs.map((x) => x.total_ms)
  const spread = (xs: number[]) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs) })
  const noisy = [totals(cli), totals(srv)].some((xs) => Math.max(...xs) / Math.min(...xs) > 2)

  const result = {
    protocol: "beadbox-6x2 frozen threshold (P1-P4)",
    size: a.size,
    tier: isL ? "L" : "S",
    seed: a.seed,
    runs: a.runs,
    bd: { path: a.bd, sha256, version: bdVersion },
    shipped_cli_list_at_this_size: shippedCliList,
    cli_list_max_buffer: a.cliListMaxBuffer,
    shipped_cli_list_max_buffer: 10 * 1024 * 1024,
    dolt: doltVersion,
    machine,
    platform: `${process.platform} ${execFileSync("sw_vers", ["-productVersion"]).toString().trim()}`,
    verdict: { P1, P2, P3, P4, PASS: P1 && P2 && P3 && P4, rerun_required_for_noise: noisy },
    p4_examined: examined,
    ratios: pairs,
    median_ratio: ratios.length ? median(ratios) : null,
    worst_ratio: ratios.length ? Math.max(...ratios) : null,
    totals: { cli: spread(totals(cli)), serve: spread(totals(srv)) },
    interaction: { tree, detail },
    serve_startup_ms: spread(srv.map((x) => x.startup_ms)),
    samples: sessions,
  }
  writeFileSync(a.out, `${JSON.stringify(result, null, 2)}\n`)
  console.error(`[bench] ${result.verdict.PASS ? "PASS" : "FAIL"} at ${a.size}: P1=${P1} P2=${P2} P3=${P3} P4=${P4} -> ${a.out}`)
}

main().catch((e) => {
  cleanupAll()
  console.error(`[bench] aborted: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
