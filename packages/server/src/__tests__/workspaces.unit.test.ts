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
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  addWorkspaceByPath,
  getLocalWorkspaceOverlaps,
  getRegisteredWorkspacesForSelector,
  getWorkspaces,
  removeWorkspace,
  setActiveWorkspaceAction,
  setWorkspaceLabel,
} from "../handlers/workspaces"
import { addWorkspace, readRegistry } from "../lib/workspace-registry"

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

  test("imports the server port from dolt-server.port when metadata omits it", async () => {
    const projectDir = join(sandboxDir, "remote-project")
    const beadsDir = await makeBeadsDir("remote-project")
    await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({
      dolt_mode: "server",
      dolt_server_host: "10.7.0.251",
      dolt_database: "gtp",
    }))
    await writeFile(join(beadsDir, "dolt-server.port"), "45522\n")

    const result = await addWorkspaceByPath(projectDir)
    expect(result.success).toBe(true)
    const registry = await readRegistry()
    expect(registry.workspaces[0].server).toMatchObject({
      host: "10.7.0.251",
      port: 45522,
      database: "gtp",
    })
  })

  test("prefers an explicit metadata port over dolt-server.port", async () => {
    const projectDir = join(sandboxDir, "explicit-port")
    const beadsDir = await makeBeadsDir("explicit-port")
    await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({
      dolt_mode: "server",
      dolt_server_host: "10.7.0.251",
      dolt_server_port: 45523,
      dolt_database: "gtp",
    }))
    await writeFile(join(beadsDir, "dolt-server.port"), "45522\n")

    const result = await addWorkspaceByPath(projectDir)
    expect(result.success).toBe(true)
    const registry = await readRegistry()
    expect(registry.workspaces[0].server?.port).toBe(45523)
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

describe("setWorkspaceLabel", () => {
  async function registerOne(): Promise<string> {
    const beads = await makeBeadsDir("labelled")
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

  test("renames the entry and returns the resolved workspace", async () => {
    await registerOne()
    const result = await setWorkspaceLabel("w1", { name: "  Renamed   project " })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.workspace.name).toBe("Renamed project")

    const reg = await readRegistry()
    expect(reg.workspaces[0].name).toBe("Renamed project")
  })

  test("stores an emoji icon and clears it with null", async () => {
    await registerOne()
    const set = await setWorkspaceLabel("w1", { icon: "🚀" })
    expect(set.success).toBe(true)
    if (set.success) expect(set.workspace.icon).toBe("🚀")
    expect((await readRegistry()).workspaces[0].icon).toBe("🚀")

    const cleared = await setWorkspaceLabel("w1", { icon: null })
    expect(cleared.success).toBe(true)
    if (cleared.success) expect(cleared.workspace.icon).toBeUndefined()
    expect((await readRegistry()).workspaces[0].icon).toBeUndefined()
  })

  test("an empty icon string clears the icon", async () => {
    await registerOne()
    await setWorkspaceLabel("w1", { icon: "🚀" })
    await setWorkspaceLabel("w1", { icon: "   " })
    expect((await readRegistry()).workspaces[0].icon).toBeUndefined()
  })

  test("rejects an empty name, an over-long name and a control-char icon", async () => {
    await registerOne()
    expect(await setWorkspaceLabel("w1", { name: "   " })).toEqual({
      success: false,
      error: "Name cannot be empty.",
    })
    const long = await setWorkspaceLabel("w1", { name: "x".repeat(65) })
    expect(long.success).toBe(false)
    const control = await setWorkspaceLabel("w1", { icon: "a\u0007" })
    expect(control).toEqual({ success: false, error: "Icon must be a single emoji." })
    const pasted = await setWorkspaceLabel("w1", { icon: "not an emoji, a sentence" })
    expect(pasted).toEqual({ success: false, error: "Icon must be a single emoji." })

    const reg = await readRegistry()
    expect(reg.workspaces[0].name).toBe("Original")
    expect(reg.workspaces[0].icon).toBeUndefined()
  })

  test("reports an unknown workspace id", async () => {
    await registerOne()
    expect(await setWorkspaceLabel("nope", { name: "x" })).toEqual({
      success: false,
      error: "Workspace not found.",
    })
  })

  test("rejects a short non-emoji icon and accepts multi-code-point emoji", async () => {
    await registerOne()
    // Short enough to clear the length cap: only the emoji rule catches it.
    expect(await setWorkspaceLabel("w1", { icon: "abc" })).toEqual({
      success: false,
      error: "Icon must be a single emoji.",
    })
    expect((await readRegistry()).workspaces[0].icon).toBeUndefined()

    const zwj = await setWorkspaceLabel("w1", { icon: "\uD83D\uDC69\u200D\uD83D\uDCBB" })
    expect(zwj.success).toBe(true)
    expect((await readRegistry()).workspaces[0].icon).toBe("\uD83D\uDC69\u200D\uD83D\uDCBB")

    const vs16 = await setWorkspaceLabel("w1", { icon: "\u2764\uFE0F" })
    expect(vs16.success).toBe(true)
    expect((await readRegistry()).workspaces[0].icon).toBe("\u2764\uFE0F")
  })

  test("accepts a keycap icon but still rejects its bare base character", async () => {
    await registerOne()
    // The OS emoji picker offers keycaps, and the tab dialog's free-text
    // field passes through whatever it produces. The base is an ASCII digit,
    // so the Extended_Pictographic rule alone rejects it.
    const keycap = await setWorkspaceLabel("w1", { icon: "1\uFE0F\u20E3" })
    expect(keycap.success).toBe(true)
    expect((await readRegistry()).workspaces[0].icon).toBe("1\uFE0F\u20E3")

    const hash = await setWorkspaceLabel("w1", { icon: "#\uFE0F\u20E3" })
    expect(hash.success).toBe(true)

    // Without the enclosing keycap the same base is just a character.
    expect(await setWorkspaceLabel("w1", { icon: "1" })).toEqual({
      success: false,
      error: "Icon must be a single emoji.",
    })
    expect(await setWorkspaceLabel("w1", { icon: "#" })).toEqual({
      success: false,
      error: "Icon must be a single emoji.",
    })
    expect((await readRegistry()).workspaces[0].icon).toBe("#\uFE0F\u20E3")
  })

  test("rejects a non-string name and a non-object label without throwing", async () => {
    await registerOne()
    expect((await setWorkspaceLabel("w1", { name: 42 as never })).success).toBe(false)
    expect((await setWorkspaceLabel("w1", "Renamed" as never)).success).toBe(false)
    expect((await setWorkspaceLabel("w1", null as never)).success).toBe(false)
    expect((await setWorkspaceLabel("w1", { icon: 7 as never })).success).toBe(false)

    const reg = await readRegistry()
    expect(reg.workspaces[0].name).toBe("Original")
    expect(reg.workspaces[0].icon).toBeUndefined()
  })

  test("rejects a name carrying a control character or a bidi override", async () => {
    await registerOne()
    expect(await setWorkspaceLabel("w1", { name: "Proj\u0007ect" })).toEqual({
      success: false,
      error: "Name contains characters that cannot be displayed.",
    })
    expect(await setWorkspaceLabel("w1", { name: "Proj\u202Eect" })).toEqual({
      success: false,
      error: "Name contains characters that cannot be displayed.",
    })
    expect((await readRegistry()).workspaces[0].name).toBe("Original")
  })

  test("an empty patch returns the workspace without touching the registry file", async () => {
    await registerOne()
    const before = await readFile(sandboxRegistry, "utf-8")
    const result = await setWorkspaceLabel("w1", {})
    expect(result.success).toBe(true)
    if (result.success) expect(result.workspace.name).toBe("Original")
    expect(await readFile(sandboxRegistry, "utf-8")).toBe(before)
  })

  test("an unknown workspace id does not rewrite the registry file", async () => {
    await registerOne()
    const before = await readFile(sandboxRegistry, "utf-8")
    expect(await setWorkspaceLabel("nope", { name: "x" })).toEqual({
      success: false,
      error: "Workspace not found.",
    })
    expect(await readFile(sandboxRegistry, "utf-8")).toBe(before)
  })
})

describe("registry write serialization", () => {
  test("concurrent label writes both land and leave valid JSON", async () => {
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

    // The rail used to fire name and icon as two rpc calls; each is a
    // read-modify-write of registry.json. Interleaved, one update was lost
    // and the truncating write left unparseable bytes on disk.
    const [renamed, iconed] = await Promise.all([
      setWorkspaceLabel("w1", { name: "Renamed" }),
      setWorkspaceLabel("w1", { icon: "🐏" }),
      setActiveWorkspaceAction(beads),
    ])
    expect(renamed.success).toBe(true)
    expect(iconed.success).toBe(true)

    const raw = await readFile(sandboxRegistry, "utf-8")
    expect(() => JSON.parse(raw)).not.toThrow()

    const reg = await readRegistry()
    expect(reg.workspaces).toHaveLength(1)
    expect(reg.workspaces[0].name).toBe("Renamed")
    expect(reg.workspaces[0].icon).toBe("🐏")
    expect(reg.activeWorkspace).toBe("w1")
  })

  test("an unparseable registry is quarantined instead of silently emptied", async () => {
    await writeFile(sandboxRegistry, '{"version": 2, "workspa')

    const reg = await readRegistry()
    expect(reg.workspaces).toEqual([])

    const files = await readdir(sandboxDir)
    expect(files.some((f) => f.startsWith("registry.json.corrupt-"))).toBe(true)
    expect(files).not.toContain("registry.json")
  })

  test("a valid-JSON registry with a structurally odd entry is not quarantined", async () => {
    const beads = await makeBeadsDir("sane")
    await writeRegistry({
      version: 2,
      activeWorkspace: null,
      workspaces: [
        {
          id: "odd",
          name: "Odd",
          addedAt: "2026-01-01",
          local: {},
          server: null,
          mode: "embedded",
        },
        {
          id: "bad-path",
          name: "BadPath",
          addedAt: "2026-01-01",
          local: { path: 42 },
          server: null,
          mode: "embedded",
        },
        {
          id: "sane",
          name: "Sane",
          addedAt: "2026-01-01",
          local: { path: beads },
          server: null,
          mode: "embedded",
        },
      ],
    })

    // Odd entries are dropped on load; they are not evidence of corrupt JSON.
    expect((await getWorkspaces()).map((w) => w.id)).toEqual(["sane"])

    const files = await readdir(sandboxDir)
    expect(files).toContain("registry.json")
    expect(files.some((f) => f.startsWith("registry.json.corrupt-"))).toBe(false)
  })

  test("a read failure that is not ENOENT propagates instead of reporting empty", async () => {
    // A directory where the registry should be makes readFile fail with
    // EISDIR. Swallowing that returned an empty registry, and the next
    // mutation persisted the emptiness over a file it had failed to read.
    const asDirectory = join(sandboxDir, "registry-as-dir.json")
    await mkdir(asDirectory, { recursive: true })
    process.env.BEADBOX_REGISTRY_PATH = asDirectory

    await expect(readRegistry()).rejects.toThrow()
  })

  test("the written registry is owner-only and leaves no tmp file behind", async () => {
    const beads = await makeBeadsDir("perms")
    await writeRegistry({
      version: 2,
      activeWorkspace: null,
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

    expect((await setWorkspaceLabel("w1", { name: "Renamed" })).success).toBe(true)

    const mode = (await stat(sandboxRegistry)).mode & 0o777
    expect(mode).toBe(0o600)
    expect((await readdir(sandboxDir)).filter((f) => f.endsWith(".tmp"))).toEqual([])
  })

  // beadbox-6q7: a v1 registry (no version field) is migrated in memory on
  // read. The migration used to persist itself with a fire-and-forget write,
  // which the #33 queue turned into a write at the queue TAIL — landing after
  // any mutation queued meanwhile and reverting it with the pre-mutation
  // snapshot. These two tests can only be reached with a v1 seed; every other
  // seed in this file writes version: 2.
  function seedV1(prePath: string): Promise<void> {
    return writeRegistry({
      workspaces: [{ path: prePath, name: "pre", addedAt: "2026-01-01" }],
      activeWorkspace: prePath,
    })
  }

  test("two mutations racing the v1 migration both survive", async () => {
    const pre = await makeBeadsDir("pre")
    const a = await makeBeadsDir("a")
    const b = await makeBeadsDir("b")
    await seedV1(pre)

    const [idA, idB] = await Promise.all([addWorkspace(a, "A"), addWorkspace(b, "B")])
    expect(idA).not.toBe(idB)
    // Drain the queue: the reverting write (when present) is queued BEHIND the
    // second mutation, so it lands after Promise.all resolves. A no-op
    // mutation (re-adding A dedups to the existing id) waits behind it.
    expect(await addWorkspace(a, "A")).toBe(idA)

    const onDisk = JSON.parse(await readFile(sandboxRegistry, "utf-8"))
    expect(onDisk.version).toBe(2)
    const paths = onDisk.workspaces.map((w: { local: { path: string } | null }) => w.local?.path)
    expect(paths).toEqual([pre, a, b])
    // activeWorkspace was remapped from the v1 path to the migrated entry's id.
    expect(onDisk.activeWorkspace).toBe(onDisk.workspaces[0].id)
  })

  test("a plain read of a v1 registry persists v2 before returning, with stable ids", async () => {
    const pre = await makeBeadsDir("pre")
    await seedV1(pre)

    const first = await readRegistry()
    expect(first.version).toBe(2)
    const onDisk = JSON.parse(await readFile(sandboxRegistry, "utf-8"))
    expect(onDisk.version).toBe(2)
    expect(onDisk.workspaces[0].id).toBe(first.workspaces[0].id)

    // Ids are minted during migration; a second read must see the persisted
    // ones, not mint another set (the client's cookie holds the id).
    const second = await readRegistry()
    expect(second.workspaces[0].id).toBe(first.workspaces[0].id)
    expect(second.activeWorkspace).toBe(first.activeWorkspace)
  })
})
