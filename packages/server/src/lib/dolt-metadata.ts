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

import { readFile } from "fs/promises"
import { basename, dirname, join, resolve } from "path"
import { portFilePath, readPortFile } from "./dolt-port-file"

export type DoltMode = "embedded" | "server"

/**
 * Detect whether a workspace runs Dolt embedded (in-process) or as a server.
 *
 * Detection cascade:
 *   1. URI prefix `server://` -> always server mode.
 *   2. `.beads/dolt-server.port` exists with a valid port -> server mode.
 *   3. `.beads/metadata.json` has `dolt_mode === "server"` -> server mode.
 *   4. Anything else (including missing files / unparseable JSON) -> embedded.
 */
export async function readMetadataMode(dbPath: string): Promise<DoltMode> {
  // Server-only workspace URIs are always server mode
  if (dbPath.startsWith("server://")) return "server"

  try {
    const resolved = resolve(dbPath)
    const beadsDir = basename(resolved) === ".beads" ? resolved : dirname(resolved)

    const portFile = await readPortFile(beadsDir)
    if (portFile.status === "ok") return "server"
    if (portFile.status === "unreadable") {
      process.stderr.write(
        `[dolt-metadata] failed to read ${portFilePath(beadsDir)}: code=${portFile.error.code}, ${portFile.error.message}\n`,
      )
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
    process.stderr.write(
      `[dolt-metadata] metadata.json exists but could not be parsed for ${dbPath}, falling back to embedded mode\n`,
    )
    return "embedded"
  }
}
