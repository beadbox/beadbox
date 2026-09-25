// Workspace write-marker discovery.
//
// Shared helper for change-detector.ts (subscription fingerprint) and
// bd.ts (cache-validation fingerprint). Both consumers need to know
// "did anything change since I last checked?" — both swap in lockstep
// so subscription emission and cache invalidation agree on freshness.
//
// Signal-source history (we get one wrong per bd major, on average):
//   1. .beads/last-touched (bd <=0.56): bd 1.0.x repurposed as a READ
//      marker — touched by bd show — so renderer detail-panel queries
//      caused spurious refresh loops. Retired by bb-onv3.9 + bb-onv3.11.
//   2. <noms>/journal.idx mtime+size (bb-onv3.9, bd 1.0.0–1.0.1): held
//      briefly. Broke under bd 1.0.2 embedded compaction which rewrites
//      journal.idx ~every 3s on quiet workspaces (empirical: size flapped
//      1377324 ↔ 1387645 with NO user writes, beadbox-e9b).
//   3. <noms>/manifest CONTENT-HASH (beadbox-v7l, current): the Dolt
//      manifest's bytes encode the current commit hash + root pointer.
//      Real writes change the bytes; bd show / bd list / Dolt GC do not.
//      File is small (~148 bytes) so content hashing is cheaper than
//      walking multiple stat()s.
//
// Empirical re-evaluation 2026-05-20 (bd 1.0.2 embedded, hover ws):
//
//   FILE                                    QUIET WS   bd create   bd show   bd list   Dolt GC   VERDICT
//   <noms>/journal.idx  (mtime+size)        NOISY      flips       no        no        flips     BROKEN
//   <noms>/journal.idx  (size only)         quiet*     grows       no        no        oscillates UNRELIABLE
//   <noms>/manifest     (mtime)             NOISY      flips       no        no        flips     BROKEN
//   <noms>/manifest     (CONTENT-HASH)      quiet      flips       no        no        no        CANONICAL ✓
//   <noms>/vvv…v        (mtime)             NOISY      flips       no        no        flips     BROKEN
//   <noms>/vvv…v        (size only)         quiet      grows       no        no        no        OK but parallel
//   .beads/issues.jsonl                     quiet      not synchronous (export hook lags)        UNUSABLE
//   .beads/last-touched                     quiet      flips       FLIPS     no        no        SELF-TRIGGERS
//
//   * journal.idx size oscillates during compaction but isn't continuously
//     drifting; suppression would be possible but content-hashing manifest
//     is structurally cleaner.
//
// Why manifest CONTENT works where everything else fails: the Dolt
// manifest file is the repo's canonical "what's the current root?"
// pointer. By construction it changes if and only if a new commit
// lands. Renames during compaction don't touch it (compaction is a
// data-equivalence operation; the root pointer stays the same).
//
// On the next bd major bump (1.1.x, 2.0.0, ...), re-run this matrix
// before trusting the manifest-content row. A CI guard test recommended
// in beadbox-v7l Notes is meant to catch silent drift.
//
// Per-workspace cost: one readFile of ~150 bytes per call. Sub-millisecond.

import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type { DoltMode } from "./types"

/**
 * Resolve a workspace's `.beads` directory from any path under it.
 * Returns the directory itself if dbPath already ends in `.beads`,
 * otherwise the parent (`dbPath`'s `dirname`). Useful for any caller
 * that needs to write/read files siblings to the Dolt store.
 */
export function getBeadsDir(dbPath: string): string {
  const resolved = resolve(dbPath)
  return basename(resolved) === ".beads" ? resolved : dirname(resolved)
}

/**
 * Resolve a workspace's Dolt root directory. Returns the embedded variant
 * if it exists (Beadbox's embedded mode places Dolt data in
 * `<beads-dir>/embeddeddolt/`), otherwise the server variant
 * (`<beads-dir>/dolt/`). Both shapes nest per-database subdirs containing
 * `.dolt/noms/manifest`.
 */
export function getDoltDir(dbPath: string): string {
  const beadsDir = getBeadsDir(dbPath)
  const embeddedDir = join(beadsDir, "embeddeddolt")
  if (existsSync(embeddedDir)) return embeddedDir
  return join(beadsDir, "dolt")
}

/**
 * Enumerate every `<dbname>/.dolt/noms/manifest` under the workspace's
 * Dolt root. The CONTENTS of these files are the write-marker; callers
 * are expected to read + hash them, not stat them.
 *
 * Empty array means the workspace is uninitialized, Dolt's on-disk layout
 * has changed, or there is no valid marker for the mode (in which case the
 * caller should fall back to a cold-path / never-cached behavior).
 *
 * beadbox-01f.3: server mode has no valid manifest marker. A Dolt server
 * rewrites journal files per commit, not the manifest (which changes only
 * when the server starts), and an embeddeddolt/ next to a server store is a
 * stale leftover nobody writes. Hashing either gives one first-run tick and
 * then silence, so server mode returns [] and leaves detection to the poll
 * child rather than pretending to be live.
 */
export async function getWorkspaceWriteMarkerPaths(
  dbPath: string,
  mode: DoltMode,
): Promise<string[]> {
  if (mode === "server") return []
  const doltDir = getDoltDir(dbPath)
  if (!existsSync(doltDir)) return []
  let entries: string[]
  try {
    entries = await readdir(doltDir)
  } catch {
    return []
  }
  const paths: string[] = []
  for (const entry of entries) {
    const candidate = join(doltDir, entry, ".dolt", "noms", "manifest")
    if (existsSync(candidate)) paths.push(candidate)
  }
  return paths
}
