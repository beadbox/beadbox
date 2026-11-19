// beadbox-984: setWorkspaceOrder persists the Workspaces sidebar order as the
// registry's array order, on a scratch registry. Covers AC3 (saved in
// Beadbox's own registry, survives a fresh read, nothing written under any
// .beads) and AC4 (a new workspace goes last, a removal keeps the rest's
// relative order, stale or bad requests are handled without errors).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  getRegisteredWorkspacesForSelector,
  setWorkspaceOrder,
} from "../handlers/workspaces"
import {
  addWorkspace,
  readRegistry,
  removeWorkspaceFromRegistry,
} from "../lib/workspace-registry"

const ORIGINAL_REGISTRY_PATH = process.env.BEADBOX_REGISTRY_PATH
const ORIGINAL_BEADS_REGISTRY_PATH = process.env.BEADS_REGISTRY_PATH
let sandboxDir: string
let sandboxRegistry: string

beforeEach(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), "beadbox-order-"))
  sandboxRegistry = join(sandboxDir, "registry.json")
  process.env.BEADBOX_REGISTRY_PATH = sandboxRegistry
  process.env.BEADS_REGISTRY_PATH = join(sandboxDir, "legacy-registry.json")
})

afterEach(async () => {
  if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true })
  if (ORIGINAL_REGISTRY_PATH === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = ORIGINAL_REGISTRY_PATH
  if (ORIGINAL_BEADS_REGISTRY_PATH === undefined) delete process.env.BEADS_REGISTRY_PATH
  else process.env.BEADS_REGISTRY_PATH = ORIGINAL_BEADS_REGISTRY_PATH
})

/** A local workspace with a .beads that looks like bd's (Dolt dir, config, metadata). */
async function makeWorkspace(name: string): Promise<string> {
  const beads = join(sandboxDir, name, ".beads")
  await mkdir(join(beads, "dolt"), { recursive: true })
  await writeFile(join(beads, "config.yaml"), `# ${name}\nissue-prefix: ${name}\n`)
  await writeFile(join(beads, "metadata.json"), JSON.stringify({ backend: "dolt", database: name }))
  return beads
}

/** Seed a registry of local workspaces named a, b, c, ... in that order. */
async function seed(names: string[]): Promise<Record<string, string>> {
  const dirs: Record<string, string> = {}
  for (const n of names) dirs[n] = await makeWorkspace(n)
  await writeFile(
    sandboxRegistry,
    `${JSON.stringify({
      version: 2,
      activeWorkspace: names[0] ?? null,
      workspaces: names.map((n) => ({
        id: n,
        name: n,
        addedAt: "2026-11-01T00:00:00.000Z",
        local: { path: dirs[n] },
        server: null,
        mode: "embedded",
      })),
    })}\n`,
  )
  return dirs
}

async function registryOrder(): Promise<string[]> {
  return (await readRegistry()).workspaces.map((w) => w.id)
}

/** sha256 over every file under dir, path and bytes, sorted. */
async function treeHash(dir: string): Promise<string> {
  const h = createHash("sha256")
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else h.update(p).update(await readFile(p))
    }
  }
  await walk(dir)
  return h.digest("hex")
}

describe("setWorkspaceOrder", () => {
  test("persists the new order: a fresh read and the sidebar list both return it", async () => {
    await seed(["a", "b", "c", "d", "e"])
    const result = await setWorkspaceOrder(["e", "a", "b", "c", "d"])
    expect(result).toEqual({ success: true, order: ["e", "a", "b", "c", "d"] })
    expect(await registryOrder()).toEqual(["e", "a", "b", "c", "d"])
    expect((await getRegisteredWorkspacesForSelector()).map((w) => w.id)).toEqual(["e", "a", "b", "c", "d"])
    // On disk, not only in memory: the file itself lists them in that order.
    const onDisk = JSON.parse(await readFile(sandboxRegistry, "utf-8"))
    expect(onDisk.workspaces.map((w: { id: string }) => w.id)).toEqual(["e", "a", "b", "c", "d"])
  })

  test("keeps every entry's other fields and the active workspace", async () => {
    await seed(["a", "b", "c"])
    const before = await readRegistry()
    await setWorkspaceOrder(["c", "b", "a"])
    const after = await readRegistry()
    expect(after.activeWorkspace).toBe(before.activeWorkspace)
    expect([...after.workspaces].sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [...before.workspaces].sort((x, y) => x.id.localeCompare(y.id)),
    )
  })

  test("a workspace added after a reorder goes last; the order before it holds", async () => {
    await seed(["a", "b", "c"])
    await setWorkspaceOrder(["c", "a", "b"])
    const id = await addWorkspace(await makeWorkspace("new"), "new")
    expect(await registryOrder()).toEqual(["c", "a", "b", id])
  })

  test("removing a middle workspace keeps the rest in their relative order", async () => {
    await seed(["a", "b", "c", "d"])
    await setWorkspaceOrder(["d", "b", "c", "a"])
    expect(await removeWorkspaceFromRegistry("b")).toBe(true)
    expect(await registryOrder()).toEqual(["d", "c", "a"])
  })

  test("a stale request: unknown ids are ignored and unnamed workspaces go to the end", async () => {
    await seed(["a", "b", "c", "added-elsewhere"])
    const result = await setWorkspaceOrder(["c", "removed-elsewhere", "a", "b"])
    expect(result).toEqual({ success: true, order: ["c", "a", "b", "added-elsewhere"] })
    expect(await registryOrder()).toEqual(["c", "a", "b", "added-elsewhere"])
  })

  test("an unchanged order leaves the registry file byte-identical", async () => {
    await seed(["a", "b", "c"])
    const before = await readFile(sandboxRegistry)
    expect(await setWorkspaceOrder(["a", "b", "c"])).toEqual({ success: true, order: ["a", "b", "c"] })
    expect((await readFile(sandboxRegistry)).equals(before)).toBe(true)
  })

  test.each([
    ["not an array", "a,b" as unknown],
    ["null", null as unknown],
    ["a non-string id", ["a", 7] as unknown],
    ["too many ids", Array.from({ length: 1001 }, (_, i) => `id-${i}`) as unknown],
  ])("bad input (%s): success false, registry byte-identical", async (_label, input) => {
    await seed(["a", "b", "c"])
    const before = await readFile(sandboxRegistry)
    const result = await setWorkspaceOrder(input as string[])
    expect(result.success).toBe(false)
    expect((await readFile(sandboxRegistry)).equals(before)).toBe(true)
  })

  test("nothing under any workspace's .beads changes (no bd write)", async () => {
    const dirs = await seed(["a", "b", "c"])
    const before = await Promise.all(Object.values(dirs).map(treeHash))
    await setWorkspaceOrder(["b", "c", "a"])
    await setWorkspaceOrder(["c", "b", "a"])
    expect(await Promise.all(Object.values(dirs).map(treeHash))).toEqual(before)
  })
})
