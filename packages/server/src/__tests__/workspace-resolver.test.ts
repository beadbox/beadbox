import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RegistryEntry } from "../lib/workspace-registry"
import { invalidateWorkspaceTarget, resolveWorkspaceTarget } from "../lib/workspace-resolver"

const originalRegistry = process.env.BEADBOX_REGISTRY_PATH
const originalLegacy = process.env.BEADS_REGISTRY_PATH
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-resolver-"))
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
  process.env.BEADS_REGISTRY_PATH = join(root, "no-legacy.json")
  invalidateWorkspaceTarget()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  if (originalRegistry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = originalRegistry
  if (originalLegacy === undefined) delete process.env.BEADS_REGISTRY_PATH
  else process.env.BEADS_REGISTRY_PATH = originalLegacy
})

async function save(...workspaces: RegistryEntry[]): Promise<void> {
  await writeFile(
    process.env.BEADBOX_REGISTRY_PATH!,
    JSON.stringify({
      version: 2,
      activeWorkspace: null,
      workspaces,
    }),
  )
}

function local(id: string, path: string): RegistryEntry {
  return { id, name: id, addedAt: "2026-01-01", local: { path }, server: null, mode: "embedded" }
}

function server(id: string, user = "root"): RegistryEntry {
  return {
    id,
    name: id,
    addedAt: "2026-01-01",
    local: null,
    mode: "server",
    server: { host: "Example.COM", port: 3306, database: "beads", user, tls: false },
  }
}

describe("resolveWorkspaceTarget", () => {
  test("resolves a stable immutable target and accepts one legacy path", async () => {
    const beads = join(root, "project", ".beads")
    await mkdir(join(beads, "dolt"), { recursive: true })
    await save(local("one", beads))

    const byId = await resolveWorkspaceTarget("one")
    const byPath = await resolveWorkspaceTarget(beads)
    expect(byPath).toEqual(byId)
    const canonicalBeads = await realpath(beads)
    expect(byId.localBeadsDir).toBe(canonicalBeads)
    expect(byId.cliDbPath).toBe(join(beads, "beads.db"))
    expect(byId.storageIdentity).toBe(JSON.stringify(["local", join(canonicalBeads, "dolt")]))
    expect(Object.isFrozen(byId)).toBe(true)
  })

  test("rejects missing and ambiguous local or server legacy paths", async () => {
    const beads = join(root, ".beads")
    await mkdir(beads)
    await save(local("a", beads), local("b", beads))
    await expect(resolveWorkspaceTarget(beads)).rejects.toThrow(/Ambiguous/)
    expect((await resolveWorkspaceTarget("a")).id).toBe("a")
    await expect(resolveWorkspaceTarget("missing")).rejects.toThrow(/not found/)

    await save(server("s1"), server("s2", "alice"))
    await expect(resolveWorkspaceTarget("server://Example.COM:3306/beads")).rejects.toThrow(
      /Ambiguous/,
    )
    expect((await resolveWorkspaceTarget("s2")).serverConnection?.user).toBe("alice")
  })

  test("local aliases share the canonical physical Dolt identity", async () => {
    const beads = join(root, "project", ".beads")
    const alias = join(root, "alias")
    await mkdir(join(beads, "dolt"), { recursive: true })
    await symlink(beads, alias)
    await save(local("real", beads), local("alias", alias))
    const real = await resolveWorkspaceTarget("real")
    const linked = await resolveWorkspaceTarget("alias")
    expect(linked.storageIdentity).toBe(real.storageIdentity)
    expect(linked.id).toBe("alias")
    await expect(resolveWorkspaceTarget(beads)).rejects.toThrow(/Ambiguous/)
    await expect(resolveWorkspaceTarget(alias)).rejects.toThrow(/Ambiguous/)
  })

  test("groups SQL aliases while generations track connection changes, not labels", async () => {
    const first = server("s1")
    const alias = server("s2", "alice")
    await save(first, alias)
    const target = await resolveWorkspaceTarget("s1")
    expect((await resolveWorkspaceTarget("s2")).storageIdentity).toBe(target.storageIdentity)
    first.name = "Renamed"
    await save(first, alias)
    expect((await resolveWorkspaceTarget("s1")).generation).toBe(target.generation)

    first.server!.database = "other"
    await save(first, alias)
    const changed = await resolveWorkspaceTarget("s1")
    expect(changed.generation).toBeGreaterThan(target.generation)
    expect(changed.storageIdentity).not.toBe(target.storageIdentity)
    invalidateWorkspaceTarget("s1")
    expect((await resolveWorkspaceTarget("s1")).generation).toBeGreaterThan(changed.generation)
  })

  test("managed local server uses current port file and advances generation", async () => {
    const beads = join(root, "managed", ".beads")
    await mkdir(beads, { recursive: true })
    await writeFile(
      join(beads, "metadata.json"),
      JSON.stringify({
        dolt_mode: "server",
        dolt_server_host: "127.0.0.1",
        dolt_database: "beads",
        dolt_server_user: "root",
      }),
    )
    const entry: RegistryEntry = {
      ...local("managed", beads),
      mode: "server",
      serverOwnership: "managed",
      server: { host: "127.0.0.1", port: 3306, database: "beads", user: "root", tls: false },
    }
    await save(entry)
    await writeFile(join(beads, "dolt-server.port"), "3307\n")
    const before = await resolveWorkspaceTarget("managed")
    expect(before.serverConnection?.port).toBe(3307)
    await writeFile(join(beads, "dolt-server.port"), "3308\n")
    const after = await resolveWorkspaceTarget("managed")
    expect(after.serverConnection?.port).toBe(3308)
    expect(after.generation).toBeGreaterThan(before.generation)
  })
})
