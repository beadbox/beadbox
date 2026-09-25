// beadbox-287: a Beadbox server scaffold whose project_id differs from the
// server's must reach the "Workspace needs to reconnect" screen through the
// REAL entry points, not only through classifyHealthError. These drive
// checkHealth (startup health) and the getEpics handler (the tree) over
// registry-shaped entries, with a fake bd printing bd 1.2.2's refusal verbatim.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getEpics } from "../handlers/epics"
import { __resetBdPathCache } from "../lib/bd"
import { checkHealth } from "../lib/workspace-health"
import type { RegistryEntry } from "../lib/workspace-registry"

const LOCAL_ID = "29ae6d48-c4c6-4df6-b12c-089f2b315526"
const SERVER_ID = "328c14ec-4172-44bb-a87b-e06a37ab19fa"
// bd 1.2.2's text, verbatim from a reproduction against a scratch server.
const MISMATCH = `Error: failed to open database: PROJECT IDENTITY MISMATCH — refusing to connect

  Local project ID (metadata.json):  ${LOCAL_ID}
  Database project ID:               ${SERVER_ID}

This means the Dolt server is serving a DIFFERENT project's database.`

const SERVER = { host: "127.0.0.1", port: 1, database: "team_beads", user: "alice", tls: false }
const WS_ID = "3f1b8a24-0000-4000-8000-00000000e287"

const saved = { bd: process.env.BD_PATH, registry: process.env.BEADBOX_REGISTRY_PATH }
let root: string

async function fakeBd(failWith: string): Promise<void> {
  const path = join(root, "bd")
  await writeFile(join(root, "bd-stderr.txt"), failWith)
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bd version 1.2.2 (Homebrew)"; exit 0; fi\ncat "${join(root, "bd-stderr.txt")}" >&2\nexit 1\n`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = path
  __resetBdPathCache()
}

/** A .beads with what bd init writes; ensureExternalScaffold reads both files. */
async function beadsDir(dir: string): Promise<string> {
  const beads = join(dir, ".beads")
  await mkdir(beads, { recursive: true })
  await writeFile(
    join(beads, "metadata.json"),
    JSON.stringify({
      backend: "dolt",
      dolt_mode: "server",
      dolt_database: SERVER.database,
      dolt_server_host: SERVER.host,
      dolt_server_port: SERVER.port,
      dolt_server_user: SERVER.user,
      project_id: LOCAL_ID,
    }),
  )
  await writeFile(join(beads, "config.yaml"), "dolt.auto-start: false\n")
  return beads
}

async function scaffoldEntry(): Promise<RegistryEntry> {
  const beads = await beadsDir(join(root, "workspaces", WS_ID))
  return {
    id: WS_ID,
    name: "team_beads",
    addedAt: "2026-09-25T00:00:00Z",
    local: { path: beads },
    server: SERVER,
    mode: "server",
    serverOwnership: "external",
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-287-health-"))
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
})

afterEach(async () => {
  for (const [key, value] of [
    ["BD_PATH", saved.bd],
    ["BEADBOX_REGISTRY_PATH", saved.registry],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __resetBdPathCache()
  await rm(root, { recursive: true, force: true })
})

describe("checkHealth: damaged Beadbox scaffold (beadbox-287)", () => {
  test("reports project_identity_mismatch with both ids", async () => {
    await fakeBd(MISMATCH)
    const result = await checkHealth(await scaffoldEntry())
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toEqual({
      kind: "project_identity_mismatch",
      database: "team_beads",
      localId: LOCAL_ID,
      databaseId: SERVER_ID,
    })
  })

  test("any other probe failure keeps the previous flow (no new failure mode)", async () => {
    await fakeBd("Error: dial tcp 127.0.0.1:1: connect: connection refused")
    const result = await checkHealth(await scaffoldEntry())
    // Previous behaviour for this entry with no server listening: the MySQL
    // dial decides, exactly as before the probe existed.
    expect(!result.ok && result.error.kind).not.toBe("project_identity_mismatch")
    expect(!result.ok && result.error.kind).toBe("server_unreachable")
  })

  test("a MANAGED local project with a server block keeps bd's own message", async () => {
    await fakeBd(MISMATCH)
    const beads = await beadsDir(join(root, "proj"))
    const result = await checkHealth({
      id: "3f1b8a24-0000-4000-8000-00000000e288",
      name: "proj",
      addedAt: "2026-09-25T00:00:00Z",
      local: { path: beads },
      server: SERVER,
      mode: "server",
      serverOwnership: "managed",
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.kind).not.toBe("project_identity_mismatch")
  })
})

describe("getEpics: the tree on a mismatched workspace (beadbox-287)", () => {
  test("a Beadbox scaffold gets the fatal category and the re-add advice", async () => {
    await fakeBd(MISMATCH)
    const entry = await scaffoldEntry()
    const result = await getEpics(entry.local?.path)
    expect(result.success).toBe(false)
    const error = !result.success ? result.bdLoadError : null
    expect(error?.category).toBe("project-identity-mismatch")
    expect(error?.severity).toBe("fatal")
    expect(error?.fixCommand).toBeNull()
    expect(error?.fixDescription).toContain("add the server again")
  })

  test("a project folder gets bd's advice, not the re-add advice", async () => {
    await fakeBd(MISMATCH)
    const beads = await beadsDir(join(root, "proj"))
    const result = await getEpics(beads)
    const error = !result.success ? result.bdLoadError : null
    expect(error?.category).toBe("project-identity-mismatch")
    expect(error?.fixDescription).toContain("bd doctor")
    expect(error?.fixDescription).not.toContain("add the server again")
  })
})
