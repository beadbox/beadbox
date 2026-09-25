// Which Dolt port a workspace is on (beadbox-01f.5, folded from beadbox-0h2).
//
// Every reader of .beads/dolt-server.port now shares one validator, and every
// resolver uses one order: an explicit dolt_server_port in metadata.json wins,
// then the port file, then the registry. bd treats an explicit port as a
// server it does not manage, so a leftover port file (a local, ephemeral
// port) must not override it.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDoltPortOverride } from "../lib/bd"
import { getPool, PortFileMissingError } from "../lib/dolt-pool"
import { resolvePort } from "../lib/workspace-health"
import { readWorkspacePortFile, type RegistryEntry } from "../lib/workspace-registry"

const roots: string[] = []
const savedEnvPort = process.env.BEADS_DOLT_SERVER_PORT

afterEach(async () => {
  if (savedEnvPort === undefined) delete process.env.BEADS_DOLT_SERVER_PORT
  else process.env.BEADS_DOLT_SERVER_PORT = savedEnvPort
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function beadsDir(files: { portFile?: string; metadata?: Record<string, unknown> }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beadbox-port-"))
  roots.push(root)
  const dir = join(root, ".beads")
  await mkdir(join(dir, "dolt"), { recursive: true })
  if (files.portFile !== undefined) await writeFile(join(dir, "dolt-server.port"), files.portFile)
  if (files.metadata) await writeFile(join(dir, "metadata.json"), JSON.stringify(files.metadata))
  return dir
}

// A local entry with no registry server block, so ownership inference does
// not route it to the external-server path.
function localEntry(dir: string, server: RegistryEntry["server"] = null): RegistryEntry {
  return { id: "ws", name: "ws", addedAt: "2026-09-25T00:00:00.000Z", local: { path: dir }, server, mode: "server" }
}

describe("port file validation is the same everywhere", () => {
  test("resolvePort does not read '45522abc' as port 45522", async () => {
    const dir = await beadsDir({ portFile: "45522abc\n", metadata: { dolt_mode: "server" } })
    expect(resolvePort(localEntry(dir))).toBeNull()
  })

  test("an out-of-range port file is rejected by the bd env and the connection pool alike", async () => {
    delete process.env.BEADS_DOLT_SERVER_PORT
    const dir = await beadsDir({ portFile: "70000\n", metadata: { dolt_mode: "server" } })
    expect(resolveDoltPortOverride(dir, undefined)).toBeUndefined()
    await expect(getPool(dir)).rejects.toThrow("Invalid port")
  })

  test("the pool refuses '45522abc' instead of connecting to 45522", async () => {
    const dir = await beadsDir({ portFile: "45522abc", metadata: { dolt_mode: "server" } })
    await expect(getPool(dir)).rejects.toThrow("Invalid port")
  })

  test("the pool still reports a missing port file as PortFileMissingError", async () => {
    const dir = await beadsDir({ metadata: { dolt_mode: "server" } })
    await expect(getPool(dir)).rejects.toBeInstanceOf(PortFileMissingError)
  })

  test("readWorkspacePortFile keeps its contract", async () => {
    expect(await readWorkspacePortFile(await beadsDir({ portFile: "  45522\n" }))).toBe(45522)
    expect(await readWorkspacePortFile(await beadsDir({ portFile: "+80" }))).toBeNull()
    expect(await readWorkspacePortFile(await beadsDir({}))).toBeNull()
  })
})

describe("one precedence order: explicit metadata port, then port file, then registry", () => {
  test("resolvePort: an explicit metadata port beats a leftover port file", async () => {
    const dir = await beadsDir({ portFile: "51000\n", metadata: { dolt_mode: "server", dolt_server_port: 14599 } })
    expect(resolvePort(localEntry(dir))).toBe(14599)
  })

  test("resolvePort: with no metadata port, the port file is used", async () => {
    const dir = await beadsDir({ portFile: "51000\n", metadata: { dolt_mode: "server" } })
    expect(resolvePort(localEntry(dir))).toBe(51000)
  })

  test("resolvePort: with neither, the registry port is the last resort", async () => {
    const dir = await beadsDir({ metadata: { dolt_mode: "embedded" } })
    // Ownership inference puts an entry like this (a server block, no metadata
    // port) on the managed path, which is the one being ordered here.
    const entry = localEntry(dir, { host: "127.0.0.1", port: 3307, database: "beads", user: "root", tls: false })
    expect(resolvePort(entry)).toBe(3307)
  })

  test("bd env: no BEADS_DOLT_SERVER_PORT override when metadata names the port", async () => {
    delete process.env.BEADS_DOLT_SERVER_PORT
    const dir = await beadsDir({ portFile: "51000\n", metadata: { dolt_mode: "server", dolt_server_port: 14599 } })
    expect(resolveDoltPortOverride(dir, undefined)).toBeUndefined()
  })

  test("bd env: the port file still points bd at a managed server", async () => {
    delete process.env.BEADS_DOLT_SERVER_PORT
    const dir = await beadsDir({ portFile: "51000\n", metadata: { dolt_mode: "server" } })
    expect(resolveDoltPortOverride(dir, undefined)).toBe("51000")
  })
})
