// Server ownership inference for registry entries written before
// serverOwnership existed (beadbox-01f.12).
//
// Local workspaces carry a registry `server` block too: adding a workspace by
// path backfills one from metadata.json, and nothing refreshes it when bd moves
// the server to a new port. Such an entry must stay "managed". Anything else
// sends it down the external path: health dials the stale registry port, Dolt
// auto-recovery is skipped, and the recovery console refuses to run. Only
// positive evidence makes an entry external.

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runRecoveryCommand } from "../handlers/recovery"
import { resetPathCaches } from "../lib/bd-paths"
import { resolvePort } from "../lib/workspace-health"
import { getServerOwnership, readRegistry, type RegistryEntry } from "../lib/workspace-registry"

const previousRegistry = process.env.BEADBOX_REGISTRY_PATH
const previousBdPath = process.env.BD_PATH
const roots: string[] = []

afterEach(async () => {
  if (previousRegistry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = previousRegistry
  if (previousBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = previousBdPath
  resetPathCaches()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface FixtureOptions {
  metadata: Record<string, unknown> | null // null: no metadata.json at all
  portFile?: string
  // true: place .beads at <registry dir>/workspaces/<id>/.beads, the path
  // Beadbox creates for a server connection's scaffold.
  beadboxScaffold?: boolean
  storedOwnership?: RegistryEntry["serverOwnership"]
}

// Registry entry shaped like the pre-upgrade "beadbox" workspace: local path,
// a backfilled server block on 127.0.0.1:3307, and no serverOwnership.
async function fixture(opts: FixtureOptions) {
  const root = await mkdtemp(join(tmpdir(), "beadbox-ownership-"))
  roots.push(root)
  const id = "ws-1"
  const registryPath = join(root, "registry.json")
  const beadsDir = opts.beadboxScaffold
    ? join(root, "workspaces", id, ".beads")
    : join(root, "project", ".beads")
  await mkdir(beadsDir, { recursive: true })
  if (opts.metadata) await writeFile(join(beadsDir, "metadata.json"), JSON.stringify(opts.metadata, null, 2))
  if (opts.portFile !== undefined) await writeFile(join(beadsDir, "dolt-server.port"), opts.portFile)
  const entry: RegistryEntry = {
    id,
    name: "beadbox",
    addedAt: "2026-03-24T17:06:54.504Z",
    local: { path: beadsDir },
    server: { host: "127.0.0.1", port: 3307, database: "beads", user: "root", tls: false },
    mode: "server",
    ...(opts.storedOwnership ? { serverOwnership: opts.storedOwnership } : {}),
  }
  process.env.BEADBOX_REGISTRY_PATH = registryPath
  await writeFile(registryPath, JSON.stringify({ version: 2, activeWorkspace: id, workspaces: [entry] }))
  return { root, beadsDir, entry, registryPath }
}

// A bd stand-in that records its argv, so recovery never touches a real bd or Dolt.
async function stubBd(root: string): Promise<string> {
  const log = join(root, "bd-argv.log")
  const bin = join(root, "bd-stub")
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho stub-ok\n`)
  await chmod(bin, 0o755)
  process.env.BD_PATH = bin
  resetPathCaches()
  return log
}

describe("server ownership inference", () => {
  test("stale registry port + embedded metadata (our own workspace) is managed, not unknown", async () => {
    const { entry } = await fixture({
      metadata: { database: "dolt", backend: "dolt", dolt_mode: "embedded", dolt_database: "beads" },
      portFile: "58625\n",
    })
    expect(getServerOwnership(entry)).toBe("managed")
    // The port bd actually serves on, not the registry's stale 3307.
    expect(resolvePort(entry)).toBe(58625)
  })

  test("the inferred value that gets persisted is managed", async () => {
    const { registryPath } = await fixture({
      metadata: { dolt_mode: "embedded", dolt_database: "beads" },
      portFile: "58625\n",
    })
    const registry = await readRegistry()
    expect(registry.workspaces[0].serverOwnership).toBe("managed")
    // readRegistry persists what it inferred, so this is what every later launch reads.
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8")).workspaces[0].serverOwnership
    expect(onDisk).toBe("managed")
  })

  // A registry read by the unfixed build already carries a persisted "unknown".
  test("a persisted 'unknown' is re-inferred as managed and rewritten on read", async () => {
    const { entry, registryPath } = await fixture({
      metadata: { dolt_mode: "embedded", dolt_database: "beads" },
      portFile: "58625\n",
      storedOwnership: "unknown",
    })
    expect(getServerOwnership(entry)).toBe("managed")
    const registry = await readRegistry()
    expect(registry.workspaces[0].serverOwnership).toBe("managed")
    expect(JSON.parse(await readFile(registryPath, "utf-8")).workspaces[0].serverOwnership).toBe("managed")
  })

  test("a persisted 'managed' or 'external' is kept as stored", async () => {
    const managed = await fixture({ metadata: { dolt_mode: "server", dolt_database: "beads", dolt_server_port: 14599 }, storedOwnership: "managed" })
    expect(getServerOwnership(managed.entry)).toBe("managed")
    const external = await fixture({ metadata: { dolt_mode: "embedded", dolt_database: "beads" }, storedOwnership: "external" })
    expect(getServerOwnership(external.entry)).toBe("external")
  })

  test("server-mode metadata with no explicit port is managed", async () => {
    const { entry } = await fixture({ metadata: { dolt_mode: "server", dolt_database: "beads" }, portFile: "58625\n" })
    expect(getServerOwnership(entry)).toBe("managed")
  })

  test("unreadable metadata keeps the pre-upgrade local behavior (managed)", async () => {
    const { entry } = await fixture({ metadata: null, portFile: "58625\n" })
    expect(getServerOwnership(entry)).toBe("managed")
  })

  // Controls: positive evidence still wins, so "always managed" cannot pass this file.
  test("control: Beadbox's own scaffold path is external", async () => {
    const { entry } = await fixture({
      metadata: { dolt_mode: "server", dolt_database: "beads" },
      beadboxScaffold: true,
    })
    expect(getServerOwnership(entry)).toBe("external")
  })

  test("control: an explicit dolt_server_port is external (bd suppresses auto-start for it too)", async () => {
    const { entry } = await fixture({
      metadata: { dolt_mode: "server", dolt_database: "beads", dolt_server_port: 14599 },
    })
    expect(getServerOwnership(entry)).toBe("external")
  })

  test("control: a non-loopback dolt_server_host is external", async () => {
    const { entry } = await fixture({
      metadata: { dolt_mode: "server", dolt_database: "beads", dolt_server_host: "10.0.0.5" },
    })
    expect(getServerOwnership(entry)).toBe("external")
  })
})

describe("recovery on a managed workspace with a stale registry port", () => {
  test("runs the command instead of refusing it as externally managed", async () => {
    const { root, beadsDir } = await fixture({
      metadata: { dolt_mode: "embedded", dolt_database: "beads" },
      portFile: "58625\n",
    })
    const log = await stubBd(root)
    const result = await runRecoveryCommand("bd dolt start", beadsDir)
    expect(result.error ?? "").not.toContain("externally managed")
    expect(result.success).toBe(true)
    expect(await readFile(log, "utf-8")).toContain("dolt start")
  })

  test("control: an external scaffold is still refused, and bd is never spawned", async () => {
    const { root, beadsDir } = await fixture({
      metadata: { dolt_mode: "server", dolt_database: "beads" },
      beadboxScaffold: true,
    })
    const log = await stubBd(root)
    const result = await runRecoveryCommand("bd dolt start", beadsDir)
    expect(result.success).toBe(false)
    expect(result.error).toContain("externally managed")
    expect(await readFile(log, "utf-8").catch(() => "")).toBe("")
    expect(dirname(beadsDir).endsWith(join("workspaces", "ws-1"))).toBe(true)
  })
})
