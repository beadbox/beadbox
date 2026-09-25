// Per-subscription change detector. Extracted from lib/the legacy ws transport module; same
// fingerprint / fs.watch / SQL-poll semantics. Differences:
//   - One instance per subscription (keyed by uuid in the handler), not a
//     module Map keyed by dbPath.
//   - Embedded events use the caller's `emit` callback. SQL-server poll
//     events are written by a worker directly to stderr with the same
//     subscribe-protocol wire format.
//   - stop() is async: terminates the SQL worker, waits for any in-flight
//     fingerprint check (capped), and closes timers and fs.watch handles.
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
// SQL-server polling uses direct SQL, so it does not invoke bd.
// ─────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto"
import { existsSync, type FSWatcher, watch } from "fs"
import { readFile } from "fs/promises"
import { basename, dirname, join, resolve } from "path"
import { SUBSCRIPTION_PREFIX, type SubscriptionEvent } from "../subscribe-protocol"
import { beadsDirFromDatabasePath } from "./beadtrain-fs"
import { drainPool } from "./dolt-pool"
import { getDoltDir, getWorkspaceWriteMarkerPaths } from "./dolt-write-marker"
import { findExternalWorkspaceByDbPath } from "./workspace-registry"

// Re-export getDoltDir for any out-of-tree consumer that imported it from
// here historically (bb-onv3.11 moved the implementation to a shared
// module; downstream tests/imports continue to work unchanged).
export { getDoltDir }
export { hashSummary } from "./server-poll-sql"

const COOLDOWN_MS = 1000
const POLL_INTERVAL_MS = 5000
const EMBEDDED_DEBOUNCE_MS = 2000
const SERVER_POLL_MS = 1000

/** Test-only overrides. Not used in production. */
export const _testOverrides = {
  serverPollMs: null as number | null,
  embeddedDebounceMs: null as number | null,
  pollIntervalMs: null as number | null,
}

function getServerPollMs(): number {
  return _testOverrides.serverPollMs ?? SERVER_POLL_MS
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
  if (findExternalWorkspaceByDbPath(dbPath)) return "server"

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

interface DetectorState {
  mode: DoltMode
  dbPath: string
  workspaceId?: string
  emit: EmitFn
  fsWatcher: FSWatcher | null
  trainWatcher: FSWatcher | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  pollTimer: ReturnType<typeof setInterval> | null
  pollInFlight: boolean
  lastFingerprint: string | null
  lastNotify: number
  stopped: boolean
  pollWorker: Worker | null
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

// Bun includes this worker in compiled sidecars as a second entrypoint. In a
// standalone executable, import.meta.url points at the main bundle root even
// here, so the worker path must include lib/. In source mode it is relative to
// this module instead.
// Its own event loop continues polling while the main kkrpc stdin reader is idle.
export function _startServerPollWorker(state: DetectorState, id: string): void {
  const standalone = (Bun as typeof Bun & { isStandaloneExecutable: boolean }).isStandaloneExecutable
  const workerPath = standalone
    ? new URL("./lib/server-poll-worker.ts", import.meta.url).href
    : new URL("./server-poll-worker.ts", import.meta.url).href
  const worker = new Worker(workerPath)
  state.pollWorker = worker
  let failed = false
  worker.onerror = (err) => {
    failed = true
    process.stderr.write(
      `[change-detector] poll worker error for ${state.dbPath}: ${err.message}\n`,
    )
    if (!state.stopped) state.emit({ type: "polling_error" })
  }
  worker.addEventListener("close", () => {
    state.pollWorker = null
    if (!state.stopped && !failed) {
      process.stderr.write(`[change-detector] poll worker exited unexpectedly for ${state.dbPath}\n`)
      state.emit({ type: "polling_error" })
    }
  })
  worker.postMessage({
    type: "start",
    id,
    dbPath: state.dbPath,
    workspaceId: state.workspaceId,
    intervalMs: getServerPollMs(),
    retryMs: 5000,
  })
}

export async function createChangeDetector(
  workspacePath: string,
  emit: EmitFn,
  // Server mode requires the worker to format [SUBSCRIPTION:<id>] lines.
  // Optional in the signature for backwards-compat with tests that
  // exercise embedded mode and don't provide one — caller must provide
  // it for any subscription that may resolve to server mode in
  // production.
  id?: string,
  workspaceId?: string,
): Promise<ChangeDetector> {
  const mode = await readMetadataMode(workspacePath)
  if (mode === "server" && !id) {
    throw new Error(`server-mode change detector requires a subscription id: ${workspacePath}`)
  }
  // Boot diagnostic names the wire prefix used by the SQL worker and
  // the handler's callback for other events.
  process.stderr.write(
    `[change-detector] starting for ${workspacePath} (mode: ${mode}, wire-prefix: ${SUBSCRIPTION_PREFIX}<id>)\n`,
  )

  const state: DetectorState = {
    mode,
    dbPath: workspacePath,
    workspaceId,
    emit,
    fsWatcher: null,
    trainWatcher: null,
    debounceTimer: null,
    pollTimer: null,
    pollInFlight: false,
    lastFingerprint: null,
    lastNotify: 0,
    stopped: false,
    pollWorker: null,
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
      console.warn(`fs.watch failed for ${beadsDir} (train plans): ${err instanceof Error ? err.message : String(err)}`)
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
  } else {
    _startServerPollWorker(state, id!)
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
  process.stderr.write(
    `[change-detector] emitting synthetic initial event for ${workspacePath}\n`,
  )
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
      if (state.pollWorker) {
        const worker = state.pollWorker
        state.pollWorker = null
        try {
          worker.postMessage({ type: "stop" })
          await worker.terminate()
        } catch {
          /* already closed */
        }
      }

      const deadline = Date.now() + 1000
      while (state.pollInFlight && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }

      try {
        await drainPool(state.dbPath, state.workspaceId)
      } catch (err) {
        console.warn(`[change-detector] drainPool error for ${state.dbPath}: ${err}`)
      }
    },
  }
}
