// Is a local workspace's .beads actually there? (beadbox-fdk)
//
// Pointed at a missing .beads, bd writes a ~2.1 MB embeddeddolt/ database
// (into a recreated .beads, or the project root) and then reports an empty
// issue list at exit 0, so a vanished workspace looks legitimately empty.
// Beadbox therefore checks presence itself and never runs bd on an absent
// workspace.
//
// PRESENT := <.beads>/metadata.json OR <.beads>/config.yaml. The directory
// existing is not enough: bd's litter recreates .beads holding only
// .local_version + embeddeddolt/, while a genuine init (bd 1.1.0 and 1.2.2,
// embedded and server scaffolds alike) always writes both files. Either one
// counts, so the check is no stricter than the threat.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { BdError } from "./bd-error"
import { getBeadsDir } from "./dolt-write-marker"

/** The .beads directory for a db path (".beads" itself or a file inside it). */
export function beadsDirOf(dbPath: string): string {
  return getBeadsDir(dbPath)
}

/** True when the workspace's .beads holds a genuine bd workspace. server:// URIs have no local dir. */
export function isWorkspacePresent(dbPath: string): boolean {
  if (dbPath.startsWith("server://")) return true
  const dir = beadsDirOf(dbPath)
  return existsSync(join(dir, "metadata.json")) || existsSync(join(dir, "config.yaml"))
}

/**
 * The error for a vanished workspace. fixCommand is deliberately null: this
 * category's usual `bd init --from-jsonl` would CREATE an empty workspace
 * here, and the error screen offers to run it.
 */
export function workspaceMissingError(dbPath: string): BdError {
  const dir = beadsDirOf(dbPath)
  return new BdError(`Workspace folder not found: ${dir}`, {
    category: "database-not-found",
    severity: "fatal",
    fixCommand: null,
    fixDescription:
      `The .beads folder at ${dir} is missing. It may have been moved or renamed, belong to a branch or worktree without it, or sit on a volume that isn't mounted. ` +
      "Beadbox did not run bd, so nothing was written. Restore the folder and retry, or remove this workspace.",
  })
}
