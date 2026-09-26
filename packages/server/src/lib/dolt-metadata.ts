// Dolt workspace mode detection.
//
// Extracted from lib/the legacy ws transport module (P1.2 super-authorized 2026-04-25, bb-vy13.2).
// The original the legacy ws transport module mixes WebSocket transport (517 LOC of broadcast,
// fs.watch, polling, connection management) with a small pure-file-reading
// helper that determines whether a workspace runs Dolt as an embedded engine
// or via an external server. The transport part is what P1.6 is built to
// replace; the file-reading part is needed by every handler that wants to
// optimize read paths via parallel CLI calls in server mode.
//
// This file pulls only the file-reading half into the sidecar. P6 dedup will
// collapse this and lib/the legacy ws transport module's readMetadataMode into a single source
// of truth (likely this one, since the main app's the legacy ws transport goes away).

import { readFileSync } from "fs"
import { basename, dirname, join, resolve } from "path"
import { portFilePath, readPortFileSync } from "./dolt-port-file"
import { findExternalWorkspaceByDbPath } from "./workspace-registry"

export type DoltMode = "embedded" | "server"

/**
 * THE mode oracle (beadbox-dr6). Every "embedded or server?" question in the
 * sidecar answers through this, so the change detector, the handlers and bd.ts
 * can never disagree. Order, which is bd's own rule (bd refuses `bd sql` when
 * metadata says embedded, whatever port file exists):
 *   1. `server://` URI -> server.
 *   2. `.beads/metadata.json` with an explicit `dolt_mode` of "embedded" or
 *      "server" -> that. It WINS over any port file or registry entry.
 *   3. No explicit metadata mode: an external registry entry, or a valid
 *      `.beads/dolt-server.port`, -> server.
 *   4. Otherwise -> embedded.
 * A port file left beside an embedded store (for example by a server that bd
 * auto-started while the metadata was briefly server-mode) no longer turns an
 * embedded workspace into a server one.
 */
export function resolveDoltMode(dbPath: string): DoltMode {
  if (dbPath.startsWith("server://")) return "server"
  const resolved = resolve(dbPath)
  const beadsDir = basename(resolved) === ".beads" ? resolved : dirname(resolved)

  try {
    const meta = JSON.parse(readFileSync(join(beadsDir, "metadata.json"), "utf-8"))
    if (meta?.dolt_mode === "embedded" || meta?.dolt_mode === "server") return meta.dolt_mode
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== "ENOENT") {
      process.stderr.write(
        `[dolt-metadata] metadata.json unreadable or unparseable for ${dbPath}; using port file / registry\n`,
      )
    }
  }

  if (findExternalWorkspaceByDbPath(dbPath)) return "server"
  const portFile = readPortFileSync(beadsDir)
  if (portFile.status === "ok") return "server"
  if (portFile.status === "unreadable") {
    process.stderr.write(
      `[dolt-metadata] failed to read ${portFilePath(beadsDir)}: code=${portFile.error.code}, ${portFile.error.message}\n`,
    )
  }
  return "embedded"
}

/** Async form kept for existing callers; same answer as resolveDoltMode. */
export async function readMetadataMode(dbPath: string): Promise<DoltMode> {
  return resolveDoltMode(dbPath)
}
