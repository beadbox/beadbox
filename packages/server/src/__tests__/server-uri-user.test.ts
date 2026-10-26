// A server:// workspace connects as its registered user (beadbox-yrfp, GH #62).
//
// Between adding a server workspace and its first scaffold, bd runs on the
// server:// path. parseServerUri() only knows host:port/database and defaults
// the user to root, and the password map was keyed without the user, so bd
// connected as root with the real user's password. Synthetic registry and
// passwords only; nothing here dials a server.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSavedCredentialKeys } from "../handlers/workspaces"
import { buildEnv, clearWorkspacePassword, setWorkspacePassword } from "../lib/bd"
import { classifyHealthError } from "../lib/workspace-health"
import type { RegistryEntry, ServerConnection } from "../lib/workspace-registry"

const previousRegistry = process.env.BEADBOX_REGISTRY_PATH
const roots: string[] = []
const passwordKeys: string[] = []

afterEach(async () => {
  if (previousRegistry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = previousRegistry
  for (const key of passwordKeys.splice(0)) clearWorkspacePassword(key)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const SERVER: ServerConnection = { host: "127.0.0.1", port: 14562, database: "ac", user: "beads", tls: false }
const URI = `server://${SERVER.host}:${SERVER.port}/${SERVER.database}`

function serverEntry(server: ServerConnection, local: string | null = null): RegistryEntry {
  return {
    id: "yrfp-ws",
    name: server.database,
    addedAt: new Date().toISOString(),
    local: local ? { path: local } : null,
    server,
    mode: "server",
    serverOwnership: "external",
    credentialKey: `${server.host}:${server.port}/${server.database}/${server.user}`,
  }
}

async function registry(entries: RegistryEntry[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beadbox-yrfp-"))
  roots.push(root)
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
  await writeFile(
    process.env.BEADBOX_REGISTRY_PATH,
    JSON.stringify({ version: 2, activeWorkspace: entries[0]?.id ?? null, workspaces: entries }),
  )
  return root
}

function password(key: string, value: string): void {
  passwordKeys.push(key)
  setWorkspacePassword(key, value)
}

describe("server:// workspace before its scaffold exists", () => {
  test("bd connects as the registered user, not root", async () => {
    await registry([serverEntry(SERVER)])
    const env = buildEnv({ db: URI })
    expect(env?.BEADS_DOLT_SERVER_USER).toBe("beads")
  })

  test("the registered tls setting reaches bd", async () => {
    await registry([serverEntry({ ...SERVER, tls: true })])
    expect(buildEnv({ db: URI })?.BEADS_DOLT_SERVER_TLS).toBe("1")
  })

  test("the password sent is the one stored for that user", async () => {
    await registry([serverEntry(SERVER)])
    password("127.0.0.1:14562/ac/beads", "synthetic-pw-beads")
    password("127.0.0.1:14562/ac/other", "synthetic-pw-other")
    const env = buildEnv({ db: URI })
    expect(env?.BEADS_DOLT_SERVER_USER).toBe("beads")
    expect(env?.BEADS_DOLT_PASSWORD).toBe("synthetic-pw-beads")
  })

  test("a password stored without a user is never paired with one", async () => {
    await registry([serverEntry(SERVER)])
    password("127.0.0.1:14562/ac", "synthetic-pw-unscoped")
    expect(buildEnv({ db: URI })?.BEADS_DOLT_PASSWORD).toBeUndefined()
  })

  test("an unregistered server:// URI still connects as root", async () => {
    await registry([])
    password("127.0.0.1:14562/ac/root", "synthetic-pw-root")
    const env = buildEnv({ db: URI })
    expect(env?.BEADS_DOLT_SERVER_USER).toBe("root")
    expect(env?.BEADS_DOLT_PASSWORD).toBe("synthetic-pw-root")
  })
})

describe("scaffold-backed server workspace", () => {
  test("the external scaffold path pairs the password with its user", async () => {
    const root = await registry([])
    const beadsDir = join(root, "workspaces", "yrfp-ws", ".beads")
    await mkdir(beadsDir, { recursive: true })
    await registry([serverEntry(SERVER, beadsDir)])
    password("127.0.0.1:14562/ac", "synthetic-pw-unscoped")
    password("127.0.0.1:14562/ac/beads", "synthetic-pw-beads")
    const env = buildEnv({ db: beadsDir })
    expect(env?.BEADS_DOLT_SERVER_USER).toBe("beads")
    expect(env?.BEADS_DOLT_PASSWORD).toBe("synthetic-pw-beads")
  })

  test("an unregistered scaffold finds its password under the metadata user", async () => {
    const root = await registry([])
    const beadsDir = join(root, "loose", ".beads")
    await mkdir(beadsDir, { recursive: true })
    await writeFile(
      join(beadsDir, "metadata.json"),
      JSON.stringify({
        dolt_mode: "server",
        dolt_server_host: "127.0.0.1",
        dolt_server_port: 14562,
        dolt_server_user: "beads",
        dolt_database: "ac",
      }),
    )
    password("127.0.0.1:14562/ac", "synthetic-pw-unscoped")
    password("127.0.0.1:14562/ac/beads", "synthetic-pw-beads")
    expect(buildEnv({ db: beadsDir })?.BEADS_DOLT_PASSWORD).toBe("synthetic-pw-beads")
  })
})

describe("password map keys include the user", () => {
  test("saved credentials hydrate under the full credential key", async () => {
    await registry([serverEntry(SERVER)])
    expect(await getSavedCredentialKeys()).toEqual([
      { credentialKey: "127.0.0.1:14562/ac/beads", passwordMapKey: "127.0.0.1:14562/ac/beads" },
    ])
  })

  test("access denied asks for the password under the user's key", () => {
    const error = classifyHealthError("Error 1045 (28000): Access denied", "", serverEntry(SERVER))
    expect(error).toMatchObject({ kind: "access_denied", user: "beads", passwordMapKey: "127.0.0.1:14562/ac/beads" })
  })
})

// Every consumer must resolve a server:// URI through the registry. A direct
// parseServerUri() call is the root-defaulting path this bead removed.
test("no sidecar module parses a server:// URI without the registry", async () => {
  const src = join(import.meta.dir, "..")
  const files = (await readdir(src, { recursive: true }))
    .filter((f) => f.endsWith(".ts") && !f.includes("__tests__") && !f.endsWith(".test.ts"))
  const offenders: string[] = []
  for (const file of files) {
    if (file.endsWith("workspace-registry.ts")) continue
    if ((await readFile(join(src, file), "utf8")).includes("parseServerUri(")) offenders.push(file)
  }
  expect(files.length).toBeGreaterThan(20)
  expect(offenders).toEqual([])
})
