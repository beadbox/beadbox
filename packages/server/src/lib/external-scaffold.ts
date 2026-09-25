import { randomUUID } from "crypto"
import { constants } from "fs"
import { copyFile, lstat, readFile, rename, stat, unlink, writeFile } from "fs/promises"
import { join } from "path"
import type { ServerConnection } from "./workspace-registry"

async function writePreservingOriginal(path: string, original: string, updated: string): Promise<void> {
  if (updated === original) return
  const backup = `${path}.beadbox-before-external`
  await copyFile(path, backup, constants.COPYFILE_EXCL).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
    // An earlier run's backup is kept as the original. Anything else at that
    // path (a symlink or directory shipped inside .beads) means no backup of
    // this file exists, so refuse to rewrite it.
    if (!(await lstat(backup)).isFile()) {
      throw new Error(`${backup} exists and is not a regular file; not rewriting ${path} without a backup`)
    }
  })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const mode = (await stat(path)).mode & 0o777
    await writeFile(temp, updated, { flag: "wx", mode })
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function disableAutoStart(config: string): string {
  const lines = config.split("\n")
  let inDoltSection = false
  let found = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^dolt\.auto-start\s*:/.test(line)) {
      lines[i] = "dolt.auto-start: false"
      found = true
      continue
    }
    if (/^[^\s#][^:]*:/.test(line)) inDoltSection = /^dolt\s*:/.test(line)
    if (inDoltSection && /^\s+auto-start\s*:/.test(line)) {
      lines[i] = `${line.match(/^\s*/)?.[0] ?? "  "}auto-start: false`
      found = true
    }
  }
  if (!found) return `${config.trimEnd()}\n\ndolt.auto-start: false\n`
  return lines.join("\n")
}

/** Mark a Beadbox-owned scaffold as a client of an externally managed server. */
export async function ensureExternalScaffold(
  beadsDir: string,
  server: Pick<ServerConnection, "host" | "port" | "database" | "user">,
): Promise<void> {
  const metadataPath = join(beadsDir, "metadata.json")
  const metadataRaw = await readFile(metadataPath, "utf-8")
  const metadata = JSON.parse(metadataRaw) as Record<string, unknown>
  if (metadata.dolt_mode !== "server" || metadata.dolt_database !== server.database) {
    throw new Error(`Server scaffold metadata does not match ${server.database}`)
  }
  // Compare values, not bytes: bd writes this file in its own formatting, and a
  // scaffold that already names this endpoint must be left untouched.
  if (
    metadata.dolt_server_host !== server.host ||
    metadata.dolt_server_port !== server.port ||
    metadata.dolt_server_user !== server.user
  ) {
    metadata.dolt_server_host = server.host
    metadata.dolt_server_port = server.port
    metadata.dolt_server_user = server.user
    await writePreservingOriginal(metadataPath, metadataRaw, `${JSON.stringify(metadata, null, 2)}\n`)
  }

  const configPath = join(beadsDir, "config.yaml")
  const config = await readFile(configPath, "utf-8")
  await writePreservingOriginal(configPath, config, disableAutoStart(config))
}
