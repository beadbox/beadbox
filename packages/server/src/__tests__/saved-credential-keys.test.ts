// Saved server passwords are read back on every sidecar start (beadbox-ct1).
//
// The keychain holds each password under its credentialKey
// (host:port/database/user); the sidecar's in-memory map is keyed by
// passwordMapKey (host:port/database). The client needs the KEYS to read the
// keychain and hand each password to the sidecar — so the sidecar lists them,
// and never returns a password.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSavedCredentialKeys } from "../handlers/workspaces"

const original = {
  registry: process.env.BEADBOX_REGISTRY_PATH,
  legacy: process.env.BEADS_REGISTRY_PATH,
}
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "beadbox-ct1-"))
  process.env.BEADBOX_REGISTRY_PATH = join(dir, "registry.json")
  process.env.BEADS_REGISTRY_PATH = join(dir, "legacy.json")
})

afterEach(async () => {
  for (const [k, v] of [
    ["BEADBOX_REGISTRY_PATH", original.registry],
    ["BEADS_REGISTRY_PATH", original.legacy],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(dir, { recursive: true, force: true })
})

const server = { host: "127.0.0.1", port: 14610, database: "pw1", user: "qa1pw", tls: false }

describe("getSavedCredentialKeys", () => {
  test("lists each saved server credential's keychain key and sidecar map key, never a password", async () => {
    await writeFile(
      process.env.BEADBOX_REGISTRY_PATH as string,
      JSON.stringify({
        version: 2,
        activeWorkspace: null,
        workspaces: [
          {
            id: "3f1b8a24-0000-4000-8000-000000000c71",
            name: "pw1",
            addedAt: "2026-09-25T00:00:00.000Z",
            local: { path: join(dir, "scaffold", ".beads") },
            server,
            mode: "server",
            credentialKey: "127.0.0.1:14610/pw1/qa1pw",
          },
          {
            id: "3f1b8a24-0000-4000-8000-000000000c72",
            name: "local-only",
            addedAt: "2026-09-25T00:00:00.000Z",
            local: { path: join(dir, "local", ".beads") },
            server: null,
            mode: "embedded",
          },
        ],
      }),
    )
    const keys = await getSavedCredentialKeys()
    expect(keys).toEqual([
      { credentialKey: "127.0.0.1:14610/pw1/qa1pw", passwordMapKey: "127.0.0.1:14610/pw1" },
    ])
    expect(JSON.stringify(keys)).not.toContain('password":')
  })

  test("an empty registry lists nothing", async () => {
    expect(await getSavedCredentialKeys()).toEqual([])
  })
})
