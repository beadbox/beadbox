// Unit tests for handlers/workspaces.ts (P1.3 / bb-vy13.3).
//
// Surface coverage:
//   - getWorkspaces() returns [] on empty registry; populated entries map
//     through with the right shape
//   - getRegisteredWorkspacesForSelector() returns the same set, scoped to
//     the WorkspaceCard shape
//   - removeWorkspace() finds entries by databasePath and removes them
//   - addWorkspaceByPath() rejects non-existent paths and folders with spaces
//   - setActiveWorkspaceAction() resolves databasePath → UUID and persists
//
// Branches that shell out to bd CLI (initializeWorkspace, addServerWorkspace,
// discoverServerDatabases, scanForDoltServers, replaceLocalWithServer,
// updateServerConnection, getWorkspaceCardStats) are covered by the P1.7
// parity runner against a real workspace.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  addWorkspaceByPath,
  getLocalWorkspaceOverlaps,
  getRegisteredWorkspacesForSelector,
  getWorkspaces,
  removeWorkspace,
  setActiveWorkspaceAction,
} from "../handlers/workspaces"
import { readRegistry, updateWorkspaceLocal } from "../lib/workspace-registry"

const ORIGINAL_REGISTRY_PATH = process.env.BEADBOX_REGISTRY_PATH
const ORIGINAL_BEADS_REGISTRY_PATH = process.env.BEADS_REGISTRY_PATH
let sandboxDir: string
let sandboxRegistry: string

beforeEach(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), "beadbox-ws-"))
  sandboxRegistry = join(sandboxDir, "registry.json")
  process.env.BEADBOX_REGISTRY_PATH = sandboxRegistry
  process.env.BEADS_REGISTRY_PATH = join(sandboxDir, "legacy-registry.json")
})

afterEach(async () => {
  if (sandboxDir) {
    await rm(sandboxDir, { recursive: true, force: true })
  }
  if (ORIGINAL_REGISTRY_PATH === undefined) {
    delete process.env.BEADBOX_REGISTRY_PATH
  } else {
    process.env.BEADBOX_REGISTRY_PATH = ORIGINAL_REGISTRY_PATH
  }
  if (ORIGINAL_BEADS_REGISTRY_PATH === undefined) {
    delete process.env.BEADS_REGISTRY_PATH
  } else {
    process.env.BEADS_REGISTRY_PATH = ORIGINAL_BEADS_REGISTRY_PATH
  }
})

async function writeRegistry(payload: Record<string, unknown>): Promise<void> {
  await writeFile(sandboxRegistry, JSON.stringify(payload) + "\n")
}

async function makeBeadsDir(name: string): Promise<string> {
  const beads = join(sandboxDir, name, ".beads")
  await mkdir(beads, { recursive: true })
  // Mark it as a Dolt workspace so isDoltWorkspace() succeeds without bd.
  await mkdir(join(beads, "dolt"), { recursive: true })
  return beads
}

describe("getWorkspaces", () => {
  test("returns [] for empty registry", async () => {
    const result = await getWorkspaces()
    expect(result).toEqual([])
  })

  test("maps registry entries to Workspace objects", async () => {
    const beadsA = await makeBeadsDir("project-a")
    await writeRegistry({
      version: 2,
      activeWorkspace: "a",
      workspaces: [
        {
          id: "a",
          name: "ProjectA",
          addedAt: "2026-01-01",
          local: { path: beadsA },
          server: null,
          mode: "embedded",
        },
      ],
    })

    const result = await getWorkspaces()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("a")
    expect(result[0].name).toBe("ProjectA")
    expect(result[0].mode).toBe("embedded")
    expect(result[0].available).toBe(true) // dolt/ subdir exists
    expect(result[0].registered).toBe(true)
    expect(result[0].databasePath).toBe(beadsA)
  })

  test("server-only workspaces report as available without filesystem check", async () => {
    await writeRegistry({
      version: 2,
      activeWorkspace: "s",
      workspaces: [
        {
          id: "s",
          name: "remote-db",
          addedAt: "2026-01-01",
          local: null,
          server: {
            host: "127.0.0.1",
            port: 3308,
            database: "beads_remote",
            user: "root",
            tls: false,
          },
          mode: "server",
        },
      ],
    })

    const result = await getWorkspaces()
    expect(result).toHaveLength(1)
    expect(result[0].available).toBe(true)
    expect(result[0].mode).toBe("server")
    expect(result[0].databasePath).toBe("server://127.0.0.1:3308/beads_remote")
    expect(result[0].serverHost).toBe("127.0.0.1")
    expect(result[0].serverPort).toBe(3308)
  })
})

describe("getRegisteredWorkspacesForSelector", () => {
  test("returns the same registered set as getWorkspaces, scoped to WorkspaceCard", async () => {
    const beadsA = await makeBeadsDir("project-a")
    await writeRegistry({
      version: 2,
      activeWorkspace: null,
      workspaces: [
        {
          id: "a",
          name: "A",
          addedAt: "2026-01-01",
          local: { path: beadsA },
          server: null,
          mode: "embedded",
        },
      ],
    })

    const cards = await getRegisteredWorkspacesForSelector()
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe("a")
    expect(cards[0].name).toBe("A")
    expect(cards[0].available).toBe(true)
    expect(cards[0].mode).toBe("embedded")
  })
})

describe("removeWorkspace", () => {
  test("removes an entry by databasePath", async () => {
    const beadsA = await makeBeadsDir("project-a")
    await writeRegistry({
      version: 2,
      activeWorkspace: "a",
      workspaces: [
        {
          id: "a",
          name: "A",
          addedAt: "2026-01-01",
          local: { path: beadsA },
          server: null,
          mode: "embedded",
        },
      ],
    })

    const result = await removeWorkspace(beadsA)
    expect(result.success).toBe(true)
    if (result.success) {
      // credentialKey may be undefined when none stored
      expect(result.credentialKey).toBeUndefined()
    }
    const reg = await readRegistry()
    expect(reg.workspaces).toHaveLength(0)
  })

  test("reports not-found for an unknown path", async () => {
    await writeRegistry({ version: 2, activeWorkspace: null, workspaces: [] })
    const result = await removeWorkspace("/tmp/nonexistent/.beads")
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toMatch(/not found/i)
    }
  })
})

describe("addWorkspaceByPath", () => {
  test("rejects non-existent path", async () => {
    const result = await addWorkspaceByPath("/tmp/definitely-does-not-exist-bb-vy13-3")
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toMatch(/does not exist/i)
    }
  })

  test("rejects file paths (not a directory)", async () => {
    const filePath = join(sandboxDir, "a-file.txt")
    await writeFile(filePath, "x")
    const result = await addWorkspaceByPath(filePath)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toMatch(/not a directory/i)
    }
  })

  test("rejects folders with spaces when no .beads/ exists", async () => {
    const dirWithSpaces = join(sandboxDir, "has spaces")
    await mkdir(dirWithSpaces, { recursive: true })
    const result = await addWorkspaceByPath(dirWithSpaces)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toMatch(/cannot contain spaces/i)
    }
  })

  test("registers an existing .beads/ directory", async () => {
    // Use sandboxDir as the project root so the path is within an allowed
    // base dir (tmpdir() is on the allow list).
    const projectDir = join(sandboxDir, "myproject")
    await mkdir(join(projectDir, ".beads", "dolt"), { recursive: true })

    const result = await addWorkspaceByPath(projectDir)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.workspace.name).toBe("myproject")
      expect(result.workspace.path).toBe(projectDir)
      expect(result.workspace.databasePath).toBe(join(projectDir, ".beads"))
    }

    const reg = await readRegistry()
    expect(reg.workspaces).toHaveLength(1)
  })
})

describe("setActiveWorkspaceAction", () => {
  test("sets active workspace by databasePath", async () => {
    const beadsA = await makeBeadsDir("project-a")
    await writeRegistry({
      version: 2,
      activeWorkspace: null,
      workspaces: [
        {
          id: "a",
          name: "A",
          addedAt: "2026-01-01",
          local: { path: beadsA },
          server: null,
          mode: "embedded",
        },
      ],
    })

    await setActiveWorkspaceAction(beadsA)
    const reg = await readRegistry()
    expect(reg.activeWorkspace).toBe("a")
  })

  test("is a no-op when path doesn't match any entry", async () => {
    await writeRegistry({ version: 2, activeWorkspace: "kept", workspaces: [] })
    await setActiveWorkspaceAction("/tmp/nope/.beads")
    const reg = await readRegistry()
    expect(reg.activeWorkspace).toBe("kept")
  })
})

describe("getLocalWorkspaceOverlaps", () => {
  test("returns empty object for empty databaseNames", async () => {
    const result = await getLocalWorkspaceOverlaps("h", 1, [])
    expect(result).toEqual({})
  })

  test("returns empty object when no local workspaces in server mode match", async () => {
    await writeRegistry({ version: 2, activeWorkspace: null, workspaces: [] })
    const result = await getLocalWorkspaceOverlaps("127.0.0.1", 3308, ["beads_a", "beads_b"])
    expect(result).toEqual({})
  })
})

describe("registry write serialization", () => {
  async function seedOne(): Promise<string> {
    const beads = await makeBeadsDir("concurrent")
    await writeRegistry({
      version: 2,
      activeWorkspace: "w1",
      workspaces: [
        {
          id: "w1",
          name: "Original",
          addedAt: "2026-01-01",
          local: { path: beads },
          server: null,
          mode: "embedded",
        },
      ],
    })
    return beads
  }

  test("concurrent mutations all land and leave valid JSON", async () => {
    const beads = await seedOne()
    const second = await makeBeadsDir("concurrent-second")

    // Each mutation is a read-modify-write of registry.json. Interleaved,
    // one update was lost and the truncating write left unparseable bytes.
    await Promise.all([
      addWorkspaceByPath(dirname(second)),
      setActiveWorkspaceAction(beads),
      updateWorkspaceLocal("w1", beads),
    ])

    const raw = await readFile(sandboxRegistry, "utf-8")
    expect(() => JSON.parse(raw)).not.toThrow()

    const reg = await readRegistry()
    expect(reg.workspaces).toHaveLength(2)
    expect(reg.workspaces.map((w) => w.name)).toContain("Original")
    expect(reg.activeWorkspace).toBe("w1")
  })

  test("a mutation that changes nothing does not rewrite the file", async () => {
    await seedOne()
    const before = await readFile(sandboxRegistry, "utf-8")

    await updateWorkspaceLocal("does-not-exist", "/tmp/nope/.beads")

    expect(await readFile(sandboxRegistry, "utf-8")).toBe(before)
  })

  test("an unparseable registry is quarantined instead of silently emptied", async () => {
    await writeFile(sandboxRegistry, '{"version": 2, "workspa')

    const reg = await readRegistry()
    expect(reg.workspaces).toEqual([])

    const files = await readdir(sandboxDir)
    expect(files.some((f) => f.startsWith("registry.json.corrupt-"))).toBe(true)
    expect(files).not.toContain("registry.json")
  })

  test("a structurally odd but valid-JSON entry is skipped, not quarantined", async () => {
    await writeFile(
      sandboxRegistry,
      JSON.stringify({
        version: 2,
        activeWorkspace: null,
        workspaces: [
          { id: "bad", name: "bad", addedAt: "2026-01-01", local: {}, server: null },
          {
            id: "good",
            name: "good",
            addedAt: "2026-01-01",
            local: { path: "/tmp/good/.beads" },
            server: null,
            mode: "embedded",
          },
        ],
      }),
    )

    const reg = await readRegistry()
    expect(reg.workspaces.map((w) => w.id)).toEqual(["good"])
    const files = await readdir(sandboxDir)
    expect(files.some((f) => f.startsWith("registry.json.corrupt-"))).toBe(false)
  })
})
