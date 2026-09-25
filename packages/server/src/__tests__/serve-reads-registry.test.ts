// The serveReads opt-in is a registry field with no writer of its own yet (a
// pilot edits ~/.beadbox/registry.json by hand). These pin that the existing
// writers keep a user's choice, and that replacing a workspace does not carry
// it to a different target.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  readRegistry,
  replaceWorkspace,
  updateWorkspaceLabel,
  updateWorkspaceLocal,
  updateWorkspaceServer,
  type WorkspaceRegistry,
} from "../lib/workspace-registry"

const ID = "11111111-1111-4111-8111-111111111111"
const server = { host: "127.0.0.1", port: 3307, database: "demo", user: "root", tls: false }
let dir: string
const saved = process.env.BEADBOX_REGISTRY_PATH

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beadbox-serve-reads-"))
  process.env.BEADBOX_REGISTRY_PATH = join(dir, "registry.json")
  const registry: WorkspaceRegistry = {
    version: 2,
    activeWorkspace: ID,
    workspaces: [
      {
        id: ID,
        name: "demo",
        addedAt: "2026-09-25T00:00:00.000Z",
        local: { path: "/tmp/demo/.beads" },
        server,
        mode: "server",
        serveReads: true,
      },
    ],
  } as WorkspaceRegistry
  writeFileSync(process.env.BEADBOX_REGISTRY_PATH, JSON.stringify(registry))
})

afterEach(() => {
  if (saved === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = saved
  rmSync(dir, { recursive: true, force: true })
})

const onDisk = () =>
  JSON.parse(readFileSync(process.env.BEADBOX_REGISTRY_PATH as string, "utf-8")) as WorkspaceRegistry

test("the test registry is the temp file, never the user's", () => {
  expect(process.env.BEADBOX_REGISTRY_PATH?.startsWith(dir)).toBe(true)
})

test("reading, relabelling and re-pointing a workspace keep its opt-in", async () => {
  expect((await readRegistry()).workspaces[0].serveReads).toBe(true)
  await updateWorkspaceLabel(ID, { name: "renamed", icon: "🐝" })
  await updateWorkspaceLocal(ID, "/tmp/moved/.beads")
  await updateWorkspaceServer(ID, { ...server, port: 3308 })
  const entry = onDisk().workspaces[0]
  expect(entry.name).toBe("renamed")
  expect(entry.local?.path).toBe("/tmp/moved/.beads")
  expect(entry.serveReads).toBe(true)
})

test("replacing a workspace creates a new target that is NOT opted in", async () => {
  const newId = await replaceWorkspace(ID, "replacement", { ...server, database: "other" })
  const entry = onDisk().workspaces.find((w) => w.id === newId)
  expect(entry).toBeDefined()
  expect(entry?.serveReads).toBeUndefined()
})
