// All projects view: aggregate.readWorkspace takes a workspace id from the
// WebView, never a path. The id must match a registry entry exactly, and the
// database it reads is the one the registry names for that entry.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readWorkspace } from "../handlers/aggregate"
import { readRegistry, resolveBdDbPath } from "../lib/workspace-registry"

const ORIGINAL_REGISTRY_PATH = process.env.BEADBOX_REGISTRY_PATH
let sandboxDir: string

// The folders are never created: bd refuses a vanished workspace before it
// spawns, so these reads fail fast and touch nothing outside the sandbox.
const entry = (id: string) => ({
  id,
  name: id.toUpperCase(),
  addedAt: "2026-01-01",
  local: { path: join(sandboxDir, id, ".beads") },
  server: null,
  mode: "embedded",
})

beforeEach(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), "beadbox-aggregate-"))
  const registryPath = join(sandboxDir, "registry.json")
  process.env.BEADBOX_REGISTRY_PATH = registryPath
  await writeFile(
    registryPath,
    JSON.stringify({ version: 2, activeWorkspace: "a", workspaces: [entry("a"), entry("b")] }),
  )
})

afterEach(async () => {
  await rm(sandboxDir, { recursive: true, force: true })
  if (ORIGINAL_REGISTRY_PATH === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = ORIGINAL_REGISTRY_PATH
})

test("an unregistered id is rejected, including one shaped like a path", async () => {
  await expect(readWorkspace("missing")).rejects.toThrow("Project is no longer registered")
  await expect(readWorkspace(join(sandboxDir, "a", ".beads"))).rejects.toThrow(
    "Project is no longer registered",
  )
})

test("each id reads the database its own registry entry names", async () => {
  const registry = await readRegistry()
  const [a, b] = await Promise.all([readWorkspace("a"), readWorkspace("b")])
  for (const [reply, id] of [
    [a, "a"],
    [b, "b"],
  ] as const) {
    const named = registry.workspaces.find((w) => w.id === id)
    if (!named) throw new Error(`fixture lost ${id}`)
    expect(reply.workspaceId).toBe(id)
    expect(reply.databasePath).toBe(resolveBdDbPath(named))
    expect(reply.databasePath.startsWith(join(sandboxDir, id))).toBe(true)
    // The folder does not exist, so the read reports an error rather than data.
    expect(reply.result.success).toBe(false)
  }
})
