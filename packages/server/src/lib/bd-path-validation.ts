import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { basename, isAbsolute } from "node:path"

/** Check saved executable trust without running it; repeat before each resolution. */
export function validateBdPathStatic(path: unknown): asserts path is string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("Choose an absolute bd path without NUL bytes")
  }
  // Use the selected name, not the symlink target: serve detection sees argv[0].
  if (basename(path) !== (process.platform === "win32" ? "bd.exe" : "bd")) {
    throw new Error("Choose an executable named bd (bd.exe on Windows)")
  }
  let target: ReturnType<typeof statSync>
  try {
    target = statSync(realpathSync(path))
    if (!target.isFile()) throw new Error("Not a regular file")
    accessSync(path, constants.X_OK)
  } catch {
    throw new Error("Choose an existing regular executable file")
  }
  if ((target.mode & 0o022) !== 0) {
    throw new Error("The bd executable must not be group- or world-writable")
  }
  if (process.getuid && target.uid !== 0 && target.uid !== process.getuid()) {
    throw new Error("The bd executable must be owned by the current user or root")
  }
}
