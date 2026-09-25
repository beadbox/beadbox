import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSpecFile } from "../beads"
import { workspaceTargetOptions } from "../workspace-target-options"

const previousRegistry = process.env.BEADBOX_REGISTRY_PATH
const previousLegacy = process.env.BEADS_REGISTRY_PATH
let root: string
let beads: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-rpc-target-"))
  beads = join(root, ".beads")
  await mkdir(beads)
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
  process.env.BEADS_REGISTRY_PATH = join(root, "no-legacy.json")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  if (previousRegistry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = previousRegistry
  if (previousLegacy === undefined) delete process.env.BEADS_REGISTRY_PATH
  else process.env.BEADS_REGISTRY_PATH = previousLegacy
})

async function save(ids: string[]): Promise<void> {
  await writeFile(process.env.BEADBOX_REGISTRY_PATH!, JSON.stringify({
    version: 2,
    activeWorkspace: null,
    workspaces: ids.map((id) => ({
      id, name: id, addedAt: "2026-01-01", mode: "embedded",
      local: { path: beads }, server: null,
    })),
  }))
}

describe("workspaceTargetOptions", () => {
  test("UUID and unique legacy file path resolve to the same target", async () => {
    await save(["workspace-a"])
    const byId = await workspaceTargetOptions("workspace-a")
    const byPath = await workspaceTargetOptions(join(beads, "beads.db"))
    expect(byId.options).toEqual(byPath.options)
    expect(byId.options.workspaceId).toBe("workspace-a")
    expect(byId.options.db).toBe(join(beads, "beads.db"))
  })

  test("ambiguous registered path fails before CLI selection", async () => {
    await save(["a", "b"])
    await expect(workspaceTargetOptions(join(beads, "beads.db"))).rejects.toThrow(/Ambiguous/)
  })

  test("existing unregistered local path keeps CLI route, missing path fails", async () => {
    await save([])
    expect((await workspaceTargetOptions(beads)).options).toEqual({ db: beads })
    await expect(workspaceTargetOptions(join(root, "missing", ".beads"))).rejects.toThrow(/Workspace not found/)
  })

  test("server-only workspace has no local spec files", async () => {
    await writeFile(process.env.BEADBOX_REGISTRY_PATH!, JSON.stringify({
      version: 2,
      activeWorkspace: "remote",
      workspaces: [{
        id: "remote", name: "remote", addedAt: "2026-01-01", mode: "server",
        local: null,
        server: { host: "127.0.0.1", port: 3306, database: "beads", user: "root", tls: false },
      }],
    }))
    expect(await readSpecFile("spec.md", "remote")).toEqual({
      success: false, error: "Workspace has no local spec files",
    })
  })
})
