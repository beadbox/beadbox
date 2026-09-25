// Per-subscription change detector. Extracted from lib/the legacy ws transport module; same
// fingerprint / fs.watch / SQL-poll semantics. Differences:
//   - One instance per subscription (keyed by uuid in the handler), not a
//     module Map keyed by dbPath.
//   - Output is a single `emit` callback the caller passes in. Production
//     wires this to stderr via subscribe-protocol.formatLine; tests pass
//     a capturing array.
//   - stop() is async: waits for any in-flight poll to settle (capped),
//     clears timers, closes fs.watch, drains the dolt pool for this dbPath.
//
// ─────────────────────────────────────────────────────────────────────────
// Auto-refresh smoke-test cheat-sheet (bb-qlf3, post-bb-y93v).
//
// When verifying that the live-update pipeline is firing, use a bd write
// that ACTUALLY flips one of the polled DOLT_HASHOF_TABLE() hashes.
// Otherwise the polling loop correctly returns "no change" and the
// stamp's eventCount stays flat — looks like a fix failure but isn't.
//
//   bd write                                    | flips                      | use as smoke trigger?
//   --------------------------------------------+----------------------------+----------------------
//   bd create                                   | issues                     | yes (canonical)
//   bd close <id>                               | issues                     | yes
//   bd update --status / --priority /           | issues                     | yes
//     --title / --description / --assignee /    |                            |
//     --type                                    |                            |
//   bd update --add-label / --remove-label      | labels                     | yes (post-bb-y93v)
//   bd dep add / bd dep remove                  | dependencies               | yes (post-bb-y93v)
//   bd comments add / delete                    | comments                   | yes
//
// Recommended canonical trigger: `bd update <id> --status open` (or the
// bead's current status — re-set is idempotent at the bd CLI but Dolt
// records a new commit either way, so the issues hash flips and no
// state accumulates).
//
// History: bb-xe8g's verification used `bd update --add-label` as the
// trigger, eventCount stayed at 0, looked like the fix didn't work.
// Cost a 30-min re-investigation. Bead bb-y93v widened the polled set
// so labels writes now fire too; this comment is the institutional
// memory so future agents don't repeat the test-methodology bug.
//
// Sister gotcha: bd CLI prints orphan-detection messages on every
// invocation by default. Two silencers (bb-5zov):
//   bd config set doctor.suppress.orphan-detection true   # workspace-wide
//   bd -q / bd --quiet                                     # per-call
// The shell-spawn poll script already redirects stderr to /dev/null, so
// orphan noise doesn't reach the kkrpc pipe. For interactive bd usage,
// run the config-set once per workspace.
// ─────────────────────────────────────────────────────────────────────────

import { type ChildProcess, execFile, spawn } from "child_process"
import { createHash } from "crypto"
import { existsSync, type FSWatcher, readFileSync, watch } from "fs"
import { readFile } from "fs/promises"
import { basename, dirname, join, resolve } from "path"
import { SUBSCRIPTION_PREFIX, type SubscriptionEvent } from "../subscribe-protocol"
import { buildServerEnv, getWorkspacePassword } from "./bd"
import { resolveBdPath } from "./bd-paths"
import { beadsDirFromDatabasePath } from "./beadtrain-fs"
import { drainPool, getPool, PortFileMissingError } from "./dolt-pool"
import { getDoltDir, getWorkspaceWriteMarkerPaths } from "./dolt-write-marker"
import { parseServerUri } from "./workspace-registry"

// Re-export getDoltDir for any out-of-tree consumer that imported it from
// here historically (bb-onv3.11 moved the implementation to a shared
// module; downstream tests/imports continue to work unchanged).
export { getDoltDir }

const COOLDOWN_MS = 1000
const POLL_INTERVAL_MS = 5000
const EMBEDDED_DEBOUNCE_MS = 2000
const SERVER_POLL_MS = 1000
const MAX_BACKOFF_MS = 60_000

/** Test-only overrides. Not used in production. */
export const _testOverrides = {
  serverPollMs: null as number | null,
  maxBackoffMs: null as number | null,
  embeddedDebounceMs: null as number | null,
  pollIntervalMs: null as number | null,
}

function getServerPollMs(): number {
  return _testOverrides.serverPollMs ?? SERVER_POLL_MS
}

function getMaxBackoffMs(): number {
  return _testOverrides.maxBackoffMs ?? MAX_BACKOFF_MS
}

function getEmbeddedDebounceMs(): number {
  return _testOverrides.embeddedDebounceMs ?? EMBEDDED_DEBOUNCE_MS
}

function getPollIntervalMs(): number {
  return _testOverrides.pollIntervalMs ?? POLL_INTERVAL_MS
}

export type DoltMode = "embedded" | "server"

export type EmitFn = (event: SubscriptionEvent) => void

export interface ChangeDetector {
  stop(): Promise<void>
}

export async function readMetadataMode(dbPath: string): Promise<DoltMode> {
  if (dbPath.startsWith("server://")) return "server"

  try {
    const resolved = resolve(dbPath)
    const beadsDir = basename(resolved) === ".beads" ? resolved : dirname(resolved)

    const portFile = join(beadsDir, "dolt-server.port")
    try {
      const portContent = await readFile(portFile, "utf-8")
      const port = parseInt(portContent.trim(), 10)
      if (port > 0 && port <= 65535) return "server"
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code !== "ENOENT") {
        console.warn(
          `[change-detector] failed to read ${portFile}: code=${code}, ${err instanceof Error ? err.message : err}`,
        )
      }
    }

    const metaPath = join(beadsDir, "metadata.json")
    const content = await readFile(metaPath, "utf-8")
    const meta = JSON.parse(content)
    return meta.dolt_mode === "server" ? "server" : "embedded"
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "embedded"
    }
    console.warn(
      `[change-detector] metadata.json exists but could not be parsed for ${dbPath}, falling back to embedded mode`,
    )
    return "embedded"
  }
}

// Signal source migration history lives in dolt-write-marker.ts. Current
// (beadbox-v7l): Dolt manifest CONTENT-HASH. Both subscription emission
// and bd.ts cache invalidation key off the same source so they agree on
// what counts as fresh state. The manifest file is ~150 bytes; hashing
// it on every check is sub-millisecond.

export async function getChangeFingerprint(dbPath: string): Promise<string | null> {
  try {
    const markerPaths = await getWorkspaceWriteMarkerPaths(dbPath)

    if (markerPaths.length === 0) return null

    const parts = await Promise.all(
      markerPaths.map(async (path) => {
        const data = await readFile(path).catch(() => null)
        if (!data) return null
        const hash = createHash("sha256").update(data).digest("hex").slice(0, 16)
        return `${path}:${hash}`
      }),
    )

    const valid = parts.filter((p): p is string => p !== null)
    if (valid.length === 0) return null

    return valid.join(",")
  } catch (err) {
    console.warn(
      `[change-detector] getChangeFingerprint failed for ${dbPath}: ${err instanceof Error ? err.message : err}`,
    )
    return null
  }
}

function normalizeDbPath(dbPath: string): string {
  if (basename(dbPath) === ".beads") {
    return join(dbPath, "dolt")
  }
  return dbPath
}

function projectRootFromDb(dbPath: string): string | undefined {
  const normalized = normalizeDbPath(dbPath)
  const parent = dirname(normalized)
  if (basename(parent) === ".beads") {
    return dirname(parent)
  }
  return undefined
}

// bb-y93v: tables polled for auto-refresh change detection. Watches
// every Dolt table whose hash flip corresponds to a user-visible bead-
// state change. Verified 2026-05-03 against bd 1.0.x:
//   - issues:           --status / --priority / --title / etc., bd create / close
//   - comments:         bd comments add / delete
//   - labels:           bd update --add-label / --remove-label
//   - dependencies:     bd dep add / bd dep remove
//   - wisps + wisp_*:   wisp lifecycle (formula DAG view consumers)
// Excluded by design: events, interactions, schema_migrations, custom_*,
// metadata, repo_mtimes — pure activity log / config / housekeeping
// tables that don't reflect user-visible bead state.
//
// Both the in-process serverPoll() (legacy path, kept for tests) and
// the shell-spawn child poll loop (production path, see
// startServerPollChild) build their SQL from this list so the watched
// surface stays in sync.
const POLLED_TABLES = [
  "issues",
  "comments",
  "labels",
  "dependencies",
  "wisps",
  "wisp_comments",
  "wisp_labels",
  "wisp_dependencies",
] as const

// Short aliases for the poll result columns. Kept stable across
// deployments because hashSummary parses by alias name.
const POLLED_TABLE_ALIASES: Record<(typeof POLLED_TABLES)[number], string> = {
  issues: "ih",
  comments: "ch",
  labels: "lh",
  dependencies: "dh",
  wisps: "wh",
  wisp_comments: "wch",
  wisp_labels: "wlh",
  wisp_dependencies: "wdh",
}

function buildPollSql(quote: '"' | "'"): string {
  const cols = POLLED_TABLES.map(
    (t) => `DOLT_HASHOF_TABLE(${quote}${t}${quote}) AS ${POLLED_TABLE_ALIASES[t]}`,
  )
  return `SELECT ${cols.join(", ")}`
}

const SERVER_POLL_SQL = buildPollSql("'")

function readDoltPort(dbPath: string): string | undefined {
  try {
    const resolved = join(
      basename(dbPath) === ".beads" ? dbPath : dirname(dbPath),
      "dolt-server.port",
    )
    const port = readFileSync(resolved, "utf-8").trim()
    if (/^\d+$/.test(port)) return port
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code !== "ENOENT") {
      console.warn(
        `[change-detector] readDoltPort failed for ${dbPath}: code=${code}, ${err instanceof Error ? err.message : err}`,
      )
    }
  }
  return undefined
}

function bdServerPoll(dbPath: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const server = parseServerUri(dbPath)

  let args: string[]
  let cwd: string | undefined

  if (server) {
    const serverKey = `${server.host}:${server.port}/${server.database}`
    const password = getWorkspacePassword(serverKey)
    Object.assign(env, buildServerEnv(server, password))
    args = ["sql", SERVER_POLL_SQL, "--json", "--quiet", "--readonly"]
    cwd = undefined
  } else {
    const port = readDoltPort(dbPath)
    if (port) env.BEADS_DOLT_SERVER_PORT = port
    const wsPath = projectRootFromDb(dbPath)
    const password = wsPath ? getWorkspacePassword(wsPath) : undefined
    if (password) env.BEADS_DOLT_PASSWORD = password
    args = ["sql", SERVER_POLL_SQL, "--db", normalizeDbPath(dbPath), "--json", "--quiet", "--readonly"]
    cwd = wsPath ?? undefined
  }

  return new Promise((resolve, reject) => {
    execFile("bd", args, { timeout: 10_000, cwd, env }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout.trim())
    })
  })
}

async function serverPoll(dbPath: string): Promise<string> {
  const pool = await getPool(dbPath)
  const [rows] = await pool.query(SERVER_POLL_SQL)
  return JSON.stringify(rows)
}

export function hashSummary(pollResult: string): string | null {
  try {
    const rows = JSON.parse(pollResult)
    if (Array.isArray(rows) && rows.length > 0) {
      const r = rows[0]
      // bb-y93v: summarize every polled table's hash so log diagnostics
      // identify which surface flipped (issues vs labels vs deps etc.).
      // Order matches POLLED_TABLES for grep stability.
      const parts: string[] = []
      for (const table of POLLED_TABLES) {
        const alias = POLLED_TABLE_ALIASES[table]
        const v = r[alias]
        if (typeof v === "string") parts.push(v.slice(0, 6))
      }
      return parts.length > 0 ? parts.join(":") : null
    }
  } catch (err) {
    console.warn(
      `[change-detector] hashSummary parse failed: ${err instanceof Error ? err.message : err}`,
    )
  }
  return null
}

interface DetectorState {
  mode: DoltMode
  dbPath: string
  emit: EmitFn
  fsWatcher: FSWatcher | null
  trainWatcher: FSWatcher | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  pollTimer: ReturnType<typeof setInterval> | null
  pollInFlight: boolean
  lastPollResult: string | null
  lastFingerprint: string | null
  lastNotify: number
  consecutiveErrors: number
  errorBroadcasted: boolean
  currentBackoff: number
  portFileMissing: boolean
  stopped: boolean
  // bb-xe8g: shell-spawned child poll process for server-mode detection.
  // Replaces the in-process scheduleServerPoll setTimeout loop, which was
  // gated by kkrpc-BunIo (project_bun_stdio_patterns). Child writes
  // [SUBSCRIPTION:<id>] lines to its stderr (inherited from sidecar →
  // same pipe Tauri reads), bypassing the gated main thread.
  pollChild: ChildProcess | null
}

async function emitIfChanged(
  state: DetectorState,
  msg: SubscriptionEvent & { type: "change" },
): Promise<boolean> {
  const fp = await getChangeFingerprint(state.dbPath)
  if (fp === null) return false
  if (fp === state.lastFingerprint) return false
  state.lastFingerprint = fp
  if (state.stopped) return false
  state.emit(msg)
  return true
}

// beadbox-v7l: fs.watch only re-triggers the emit pipeline for the Dolt
// manifest file. Anything else under doltDir — journal.idx flap, table-
// data churn (vvv…v file), LOCK touches, oldgen/ compaction — is dropped
// before the debounce timer is even armed. The fingerprint guard in
// emitIfChanged then content-hashes the manifest to suppress mtime-only
// events (GC touches manifest mtime without changing its contents).
const FS_WATCH_FILENAME_ALLOWLIST = new Set(["manifest"])

// beadbox-if6 (PR #37): .beadtrain plans live at <workspace>/.beads/*.beadtrain
// and one directory down -- OUTSIDE the Dolt root the watcher above is rooted
// at, so no allowlist entry could ever have made them live. They get their own
// watcher. Deliberately NOT part of getChangeFingerprint: that path is tuned
// to hash ~150 bytes (beadbox-v7l) and must not readdir or read plan files.
// The filter is a string check per event, zero I/O, so Dolt churn under the
// same root costs one compare and nothing else.
export function isTrainFile(filename: string | null): boolean {
  // basename for the same portability reason as onFsEvent: macOS gives a
  // relative path, Windows often just the leaf.
  return !!filename && basename(filename).endsWith(".beadtrain")
}

function startEmbeddedLoop(state: DetectorState): void {
  // fs.watch is rooted at the Dolt root (same scope as bb-onv3.9). The
  // allowlist + content-hash fingerprint together do the work that
  // mtime-based filtering used to fail at under bd 1.0.2's compaction
  // (beadbox-e9b). The watch HAS to be recursive because manifest lives
  // at <doltDir>/<dbname>/.dolt/noms/manifest (3 levels deep).
  const doltDir = getDoltDir(state.dbPath)

  const onFsEvent = (_eventType: string, filename: string | null): void => {
    if (state.stopped) return
    if (!filename) return
    // basename is the only thing portable across macOS FSEvents (full
    // relative path) and Windows ReadDirectoryChangesW (often a leaf).
    if (!FS_WATCH_FILENAME_ALLOWLIST.has(basename(filename))) return
    const trigger = filename
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(async () => {
      if (state.stopped) return
      const now = Date.now()
      const elapsed = now - state.lastNotify
      if (elapsed < COOLDOWN_MS) {
        state.debounceTimer = setTimeout(async () => {
          if (state.stopped) return
          state.lastNotify = Date.now()
          await emitIfChanged(state, { type: "change", timestamp: state.lastNotify, trigger })
        }, COOLDOWN_MS - elapsed)
        return
      }
      state.lastNotify = now
      await emitIfChanged(state, { type: "change", timestamp: now, trigger })
    }, getEmbeddedDebounceMs())
  }

  if (existsSync(doltDir)) {
    try {
      state.fsWatcher = watch(doltDir, { recursive: true }, onFsEvent)
      state.fsWatcher.on("error", (err) => {
        console.warn(`fs.watch error for ${doltDir}: ${err.message}`)
        state.fsWatcher = null
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`fs.watch failed for ${doltDir}: ${msg} (using polling only)`)
    }
  } else {
    console.warn(`Dolt directory not found: ${doltDir} (using polling only)`)
  }
}

// bb-fe03.6: setTimeout callback was 82 NLOC at CCN 29 — pool/fallback
// poll, success-path recovery sequence, error-path classification +
// backoff. Extracted three helpers below. Each is exported (with the
// `_` prefix convention used elsewhere in this file's _testOverrides)
// so the test suite can assert state mutations without spinning a real
// poll loop.

// Pool-with-bd-fallback poll: try the SQL pool first; on a non-PortFileMissing
// failure where the workspace dir still exists, fall back to bd CLI. PortFile-
// Missing always rethrows so the catch block can flip portFileMissing.
async function pollWithBdFallback(state: DetectorState): Promise<string> {
  try {
    return await serverPoll(state.dbPath)
  } catch (poolErr) {
    if (poolErr instanceof PortFileMissingError) throw poolErr
    const beadsDir = state.dbPath.startsWith("server://")
      ? null
      : basename(state.dbPath) === ".beads"
        ? state.dbPath
        : dirname(state.dbPath)
    if (beadsDir && !existsSync(beadsDir)) throw poolErr
    console.warn(`[change-detector] pool query failed, falling back to bd: ${poolErr}`)
    return await bdServerPoll(state.dbPath)
  }
}

/** @internal exported for testing */
export function _handlePollSuccess(state: DetectorState, result: string): void {
  if (state.portFileMissing) {
    state.portFileMissing = false
    process.stderr.write(
      `[change-detector] dolt-server.port recovered for ${state.dbPath}, resuming normal polling\n`,
    )
  }
  if (state.errorBroadcasted) {
    state.errorBroadcasted = false
    state.consecutiveErrors = 0
    if (!state.stopped) state.emit({ type: "recovered" })
  }
  state.consecutiveErrors = 0
  state.currentBackoff = getServerPollMs()
  if (result === state.lastPollResult) return
  const prev = state.lastPollResult ? hashSummary(state.lastPollResult) : null
  state.lastPollResult = result
  const next = hashSummary(result)
  process.stderr.write(
    `[change-detector] change detected for ${state.dbPath}: ${prev ?? "(initial)"} -> ${next}\n`,
  )
  if (!state.stopped) state.emit({ type: "change", timestamp: Date.now(), prev, next })
}

/** @internal exported for testing */
export function _handlePollError(state: DetectorState, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  const stderr = (err as { stderr?: string })?.stderr ?? ""
  const combined = `${msg} ${stderr}`

  if (err instanceof PortFileMissingError) {
    if (!state.portFileMissing) {
      state.portFileMissing = true
      console.warn(
        `[change-detector] dolt-server.port missing for ${state.dbPath}, skipping server poll (will retry on next cycle)`,
      )
    }
  } else if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|connect.*refused/i.test(combined)) {
    drainPool(state.dbPath).catch(() => {})
  }

  if (/database\b.*\bnot found/i.test(combined) || /unknown database/i.test(combined)) {
    console.warn(
      `[change-detector] db-not-found for ${state.dbPath}. FULL: ${combined.slice(0, 500)}`,
    )
  } else {
    console.debug(`[change-detector] server-mode poll error for ${state.dbPath}: ${msg}`)
  }

  state.consecutiveErrors++
  emitPollErrorEvent(state)

  state.currentBackoff = /circuit breaker/i.test(combined)
    ? getMaxBackoffMs()
    : Math.min(state.currentBackoff * 2, getMaxBackoffMs())
}

// bb-mhh1.5: extracted from _handlePollError so the polling_error /
// reconnecting transition machine lives behind one entry point. Same
// semantic contract as before (pm/systemdesign.md §3.2 event vocabulary):
//   consecutiveErrors==3 + !errorBroadcasted + !stopped → polling_error (once)
//   errorBroadcasted + !stopped (post-broadcast retries) → reconnecting
// The early-return on `stopped` matches the prior `!state.stopped` gate
// at each emit site. attempt_number is the ongoing failure count;
// backoff_ms is the delay we WILL wait before the next attempt (i.e.
// the doubled value — `_handlePollError` doubles `state.currentBackoff`
// AFTER this helper returns, so we have to compute the next-cycle
// value here to report it accurately).
//
// Arrow form is deliberate: lizard 1.22.1 (bb-chq9) bundles consecutive
// top-level `function` declarations into one CCN span, which would
// re-trigger the same false-positive that motivated this refactor.
// Arrow form gives lizard a clean parse boundary (precedent:
// bb-fe03.2 / bb-fe03.4 + the existing fix in update-checker.ts and
// epic-navigation-keys.ts).
const emitPollErrorEvent = (state: DetectorState): void => {
  // errorBroadcasted is sticky: flips on the first 3-consecutive-error
  // condition regardless of stopped state (per existing test contract
  // "stopped state: polling_error broadcast does NOT emit"). Only the
  // actual emit() calls are gated on !stopped, matching the pre-refactor
  // semantics in _handlePollError.
  if (state.consecutiveErrors >= 3 && !state.errorBroadcasted) {
    state.errorBroadcasted = true
    if (!state.stopped) state.emit({ type: "polling_error" })
    return
  }
  if (state.errorBroadcasted && !state.stopped) {
    state.emit({
      type: "reconnecting",
      attempt_number: state.consecutiveErrors,
      backoff_ms: Math.min(state.currentBackoff * 2, getMaxBackoffMs()),
    })
  }
}

function scheduleServerPoll(state: DetectorState): void {
  if (state.stopped) return

  state.pollTimer = setTimeout(async () => {
    if (state.stopped) return
    if (state.pollInFlight) {
      scheduleServerPoll(state)
      return
    }
    state.pollInFlight = true
    try {
      const result = await pollWithBdFallback(state)
      _handlePollSuccess(state, result)
    } catch (err: unknown) {
      _handlePollError(state, err)
    } finally {
      state.pollInFlight = false
      scheduleServerPoll(state)
    }
  }, state.currentBackoff)
}

// bb-xe8g: shell-spawned poll loop for server-mode workspaces.
//
// The previous in-process scheduleServerPoll relied on setTimeout in the
// sidecar's main thread. kkrpc's BunIo stdin reader on that thread can
// gate setTimeout callbacks indefinitely between RPC requests
// (project_bun_stdio_patterns) — same class of bug that drove bb-x0il
// to shell-spawn the parent-death-watcher. Symptom on bb-xe8g: 4 events
// arrived early in a session while the user was active making rpc calls,
// then the user went idle on rpc and polls silently stopped.
//
// Fix: spawn a tiny shell child that polls Dolt via `bd sql`, diffs the
// result against the prior poll, and writes [SUBSCRIPTION:<id>] lines
// directly to stderr. The child's stderr is inherited from the sidecar,
// so its writes flow into the same pipe Tauri reads — no JS event loop
// involvement on the sidecar main thread. Bypasses the BunIo gate
// completely.
//
// Format of emitted lines exactly matches subscribe-protocol.formatLine:
//   [SUBSCRIPTION:<id>] {"type":"change","timestamp":N}\n
// so the existing client parser (lib/subscribe.ts) needs no changes.
//
// Embedded mode (fs.watch path) is unaffected — fs.watch is libuv FSEvents-
// driven, not timer-based, and doesn't share the gating problem.
/** @internal exported for testing — production path is the dispatch
 * inside createChangeDetector below. */
export function _startServerPollChild(state: DetectorState, id: string): void {
  startServerPollChild(state, id)
}

/**
 * Build the /bin/sh argv for the subscription poll child.
 *
 * Exported for test: everything attacker-influenceable (subscription id,
 * workspace path, resolved bd binary) is passed as a POSITIONAL and read back
 * through a quoted shell variable, so nothing user-supplied is ever spliced
 * into the script text. Only POLL_SQL — a module-derived constant — is
 * interpolated, inside single quotes.
 *
 * bd is passed in resolved rather than invoked bare: lib/exec.ts widens
 * process.env.PATH (Homebrew, ~/.local/bin, ~/go/bin) and the child inherits
 * it, so a bare `bd` would resolve through a broader search list than the
 * resolveBdPath() used by every other bd call site (beadbox-l5i.3).
 */
export function buildPollShellArgs(id: string, dbArg: string, bdPath: string): string[] {
  const POLL_SQL = buildPollSql('"')
  // beadbox-db6: the loop must die with the sidecar however the sidecar dies
  // (quit is a SIGKILL from Tauri, so no cleanup hook ever runs). The sidecar
  // holds the only write end of our stdin and never writes to it; the kernel
  // closes it when the sidecar exits for any reason, and the watcher below
  // reads EOF and signals our whole process group — this loop, its sleep, and
  // any bd sql in flight. POSIX gives a background list /dev/null as stdin, so
  // the pipe is parked on fd 3 first. The group is our own (the sidecar spawns
  // us detached); -$$ is only ever OUR group, and if it does not exist the
  // fallback signals this shell alone, never the sidecar's group.
  const SHELL_LOOP = `
exec 3<&0 </dev/null
( while read -r _ <&3; do :; done; kill -TERM -$$ 2>/dev/null || kill -TERM $$ ) &
exec 3<&-
ID="$1"
DBPATH="$2"
BD="$3"
LAST=""
ERRS=0
while true; do
  RESULT=$("$BD" sql '${POLL_SQL}' --db "$DBPATH" --json --quiet --readonly 2>/dev/null)
  RC=$?
  if [ $RC -ne 0 ]; then
    ERRS=$((ERRS + 1))
    if [ "$ERRS" = "3" ]; then
      printf '[SUBSCRIPTION:%s] {"type":"polling_error"}\\n' "$ID" >&2
    elif [ "$ERRS" -gt 3 ]; then
      # bb-v340: emit reconnecting on each retry past the initial broadcast
      # so the renderer can fire ws_reconnecting at parity with v0.24.x.
      # backoff_ms is the fixed 5000ms wait the shell loop uses between
      # retries (in-process change-detector exponentially backs off; shell
      # variant is intentionally simpler — see comment block above).
      printf '[SUBSCRIPTION:%s] {"type":"reconnecting","attempt_number":%s,"backoff_ms":5000}\\n' "$ID" "$ERRS" >&2
    fi
    sleep 5
    continue
  fi
  if [ "$ERRS" -ge 3 ]; then
    printf '[SUBSCRIPTION:%s] {"type":"recovered"}\\n' "$ID" >&2
  fi
  ERRS=0
  if [ -n "$LAST" ] && [ "$RESULT" != "$LAST" ]; then
    TS=$(date +%s)000
    printf '[SUBSCRIPTION:%s] {"type":"change","timestamp":%s}\\n' "$ID" "$TS" >&2
  fi
  LAST="$RESULT"
  sleep 1
done
`
  return ["-c", SHELL_LOOP, "--", id, dbArg, bdPath]
}

/** Signal the poll child's process group, or just the child where there is no group. */
function killPollGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already dead */
    }
  }
}

function startServerPollChild(state: DetectorState, id: string): void {
  // Mirror bdServerPoll's env construction so the child's bd CLI hits
  // the same Dolt server with the same credentials.
  const env: NodeJS.ProcessEnv = { ...process.env }
  const server = parseServerUri(state.dbPath)
  let cwd: string | undefined
  let dbArg: string
  if (server) {
    const serverKey = `${server.host}:${server.port}/${server.database}`
    const password = getWorkspacePassword(serverKey)
    Object.assign(env, buildServerEnv(server, password))
    dbArg = state.dbPath
    cwd = undefined
  } else {
    const port = readDoltPort(state.dbPath)
    if (port) env.BEADS_DOLT_SERVER_PORT = port
    const wsPath = projectRootFromDb(state.dbPath)
    const password = wsPath ? getWorkspacePassword(wsPath) : undefined
    if (password) env.BEADS_DOLT_PASSWORD = password
    dbArg = normalizeDbPath(state.dbPath)
    cwd = wsPath ?? undefined
  }

  // stdin is a pipe the sidecar never writes: its EOF is the child's
  // parent-death notice (see buildPollShellArgs). detached puts the child in
  // its own process group so that notice, and stop(), can take down the
  // whole group. Not on Windows, where detached opens a console window.
  const child = spawn("/bin/sh", buildPollShellArgs(id, dbArg, resolveBdPath()), {
    stdio: ["pipe", "ignore", "inherit"],
    env,
    cwd,
    detached: process.platform !== "win32",
  })
  state.pollChild = child

  child.on("error", (err) => {
    // Failure to spawn (e.g., /bin/sh missing — vanishingly unlikely on
    // macOS/Linux) is non-fatal; emit polling_error so the client knows
    // the channel is dead and the change-detector is degraded.
    process.stderr.write(
      `[change-detector] pollChild spawn error for ${state.dbPath}: ${err.message}\n`,
    )
    if (!state.stopped) state.emit({ type: "polling_error" })
  })
  child.on("exit", (code, signal) => {
    state.pollChild = null
    // Exit during normal stop() is expected (we kill the child). Log
    // unexpected early exits so future bb-i4qd-class regressions are
    // greppable in sidecar stderr.
    if (!state.stopped) {
      process.stderr.write(
        `[change-detector] pollChild exited unexpectedly for ${state.dbPath}: code=${code} signal=${signal}\n`,
      )
      if (!state.stopped) state.emit({ type: "polling_error" })
    }
  })
}

export async function createChangeDetector(
  workspacePath: string,
  emit: EmitFn,
  // bb-xe8g: id is required for server mode (the shell-spawn child must
  // format [SUBSCRIPTION:<id>] lines matching the in-process emit).
  // Optional in the signature for backwards-compat with tests that
  // exercise embedded mode and don't provide one — caller must provide
  // it for any subscription that may resolve to server mode in
  // production.
  id?: string,
): Promise<ChangeDetector> {
  const mode = await readMetadataMode(workspacePath)
  // Boot diagnostic also names the wire prefix the handler will wrap our
  // emissions in — the detector itself is transport-agnostic, but proving
  // the contract on a single grep line is part of the bead's AC.
  process.stderr.write(
    `[change-detector] starting for ${workspacePath} (mode: ${mode}, wire-prefix: ${SUBSCRIPTION_PREFIX}<id>)\n`,
  )

  const state: DetectorState = {
    mode,
    dbPath: workspacePath,
    emit,
    fsWatcher: null,
    trainWatcher: null,
    debounceTimer: null,
    pollTimer: null,
    pollInFlight: false,
    lastPollResult: null,
    lastFingerprint: null,
    lastNotify: 0,
    consecutiveErrors: 0,
    errorBroadcasted: false,
    currentBackoff: getServerPollMs(),
    portFileMissing: false,
    stopped: false,
    pollChild: null,
  }

  // Train plans (beadbox-if6): watched in EVERY detection mode. This is pure
  // fs on .beads/ and has no Dolt dependency, so it sits above the
  // embedded/server dispatch. Emits DIRECTLY after debounce. emitIfChanged() compares
  // fingerprints, and plan files are intentionally not in the fingerprint,
  // so routing through it would emit nothing. A workspace with no plans
  // produces no matching events, so this costs nothing there.
  const beadsDir = beadsDirFromDatabasePath(state.dbPath)
  if (beadsDir && existsSync(beadsDir)) {
    try {
      state.trainWatcher = watch(beadsDir, { recursive: true }, (_ev, filename) => {
        if (state.stopped || !isTrainFile(filename)) return
        const trigger = filename as string
        if (state.debounceTimer) clearTimeout(state.debounceTimer)
        state.debounceTimer = setTimeout(() => {
          if (state.stopped) return
          state.lastNotify = Date.now()
          state.emit({ type: "change", timestamp: state.lastNotify, trigger })
        }, getEmbeddedDebounceMs())
      })
      state.trainWatcher.on("error", (err) => {
        console.warn(`fs.watch error for ${beadsDir} (train plans): ${err.message}`)
        state.trainWatcher = null
      })
    } catch (err: unknown) {
      console.warn(
        `fs.watch failed for ${beadsDir} (train plans): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  state.pollTimer = setInterval(async () => {
    if (state.stopped || state.pollInFlight) return
    state.pollInFlight = true
    try {
      await emitIfChanged(state, { type: "change", timestamp: Date.now() })
    } finally {
      state.pollInFlight = false
    }
  }, getPollIntervalMs())

  if (mode === "embedded") {
    startEmbeddedLoop(state)
  } else if (id) {
    // bb-xe8g: prefer the shell-spawn child poll loop (bypasses kkrpc-BunIo
    // main-thread timer gating). Falls back to scheduleServerPoll only if
    // the caller didn't supply an id (legacy test paths) — production
    // callers always provide one via the subscribe handler.
    startServerPollChild(state, id)
  } else {
    process.stderr.write(
      `[change-detector] WARN: server mode without id, falling back to in-process scheduleServerPoll for ${workspacePath} (subject to bb-xe8g BunIo gating bug)\n`,
    )
    scheduleServerPoll(state)
  }

  // bb-fvw2: emit a synthetic initial "change" event immediately, BEFORE the
  // first poll runs. The client treats this as the subscription's "ready"
  // signal so any UI gated on a first event unblocks even when the change-
  // detector can't reach the underlying Dolt server (the bb-fvw2 stall vector:
  // Dolt unreachable, server poll backs off forever, no
  // "change" emit ever fires, the home-page sits on the skeleton). Real
  // changes still emit normally once the poll succeeds; the prev/next fields
  // are intentionally absent on this synthetic event so the client can tell
  // it apart from real fingerprint diffs if needed.
  process.stderr.write(`[change-detector] emitting synthetic initial event for ${workspacePath}\n`)
  emit({ type: "change", timestamp: Date.now(), trigger: "initial" })

  return {
    async stop(): Promise<void> {
      if (state.stopped) return
      state.stopped = true

      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer)
        state.debounceTimer = null
      }
      if (state.pollTimer) {
        // setInterval and setTimeout both clear safely with both APIs in Node.
        clearInterval(state.pollTimer)
        clearTimeout(state.pollTimer)
        state.pollTimer = null
      }
      if (state.fsWatcher) {
        try {
          state.fsWatcher.close()
        } catch {
          /* already closed */
        }
        state.fsWatcher = null
      }
      if (state.trainWatcher) {
        try {
          state.trainWatcher.close()
        } catch {
          /* already closed */
        }
        state.trainWatcher = null
      }
      // bb-xe8g: tear down the shell-spawn poll child. SIGTERM gives the
      // child its exit handler chance; if it doesn't exit within ~250ms
      // we follow with SIGKILL to guarantee the resource is reclaimed
      // (subscribe.leak.test.ts asserts handle delta is zero).
      if (state.pollChild) {
        const child = state.pollChild
        try {
          // Signal the child's whole group (loop, sleep, in-flight bd sql),
          // then close its stdin, which the loop also treats as "stop".
          killPollGroup(child, "SIGTERM")
          child.stdin?.destroy()
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              killPollGroup(child, "SIGKILL")
              resolve()
            }, 250)
            child.once("exit", () => {
              clearTimeout(timeout)
              resolve()
            })
          })
        } catch {
          /* tolerable during teardown */
        }
        state.pollChild = null
      }

      const deadline = Date.now() + 1000
      while (state.pollInFlight && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }

      try {
        await drainPool(state.dbPath)
      } catch (err) {
        console.warn(`[change-detector] drainPool error for ${state.dbPath}: ${err}`)
      }
    },
  }
}
