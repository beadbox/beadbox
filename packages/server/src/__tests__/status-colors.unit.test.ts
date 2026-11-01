// beadbox-o3h: per-status colors live in Beadbox's own workspace registry,
// never in bd. getStatusColors / setStatusColors round trip, Reset, and the
// validation of what crosses the rpc boundary from the WebView.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getStatusColors, setStatusColors } from "../handlers/workspaces"
import { readRegistry } from "../lib/workspace-registry"

const ORIGINAL_REGISTRY_PATH = process.env.BEADBOX_REGISTRY_PATH
let sandboxDir: string
let registryPath: string

beforeEach(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), "beadbox-colors-"))
  registryPath = join(sandboxDir, "registry.json")
  process.env.BEADBOX_REGISTRY_PATH = registryPath
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      activeWorkspace: "a",
      workspaces: [
        {
          id: "a",
          name: "A",
          icon: "🚀",
          addedAt: "2026-01-01",
          local: { path: join(sandboxDir, "a", ".beads") },
          server: null,
          mode: "server",
        },
        {
          id: "b",
          name: "B",
          addedAt: "2026-01-01",
          local: { path: join(sandboxDir, "b", ".beads") },
          server: null,
          mode: "server",
        },
      ],
    }),
  )
})

afterEach(async () => {
  await rm(sandboxDir, { recursive: true, force: true })
  if (ORIGINAL_REGISTRY_PATH === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = ORIGINAL_REGISTRY_PATH
})

describe("status colors", () => {
  test("no colors set: an empty map", async () => {
    expect(await getStatusColors("a")).toEqual({ success: true, colors: {} })
  })

  test("round trip, lowercased, per workspace, other fields untouched", async () => {
    const set = await setStatusColors("a", { open: "#FF0000", waiting_on_nelson: "#00aa11" })
    expect(set).toEqual({
      success: true,
      colors: { open: "#ff0000", waiting_on_nelson: "#00aa11" },
    })
    expect(await getStatusColors("a")).toEqual({
      success: true,
      colors: { open: "#ff0000", waiting_on_nelson: "#00aa11" },
    })
    expect(await getStatusColors("b")).toEqual({ success: true, colors: {} })
    const entry = (await readRegistry()).workspaces.find((w) => w.id === "a")
    expect(entry?.icon).toBe("🚀")
    expect(entry?.name).toBe("A")
  })

  test("null and an empty map both reset (the field leaves the registry)", async () => {
    await setStatusColors("a", { open: "#ff0000" })
    expect(await setStatusColors("a", null)).toEqual({ success: true, colors: {} })
    expect(
      JSON.parse(await readFile(registryPath, "utf-8")).workspaces[0].statusColors,
    ).toBeUndefined()
    await setStatusColors("a", { open: "#ff0000" })
    await setStatusColors("a", {})
    expect(
      JSON.parse(await readFile(registryPath, "utf-8")).workspaces[0].statusColors,
    ).toBeUndefined()
  })

  test("rejects what the WebView must not write, and writes nothing", async () => {
    const before = await readFile(registryPath, "utf-8")
    const bad: unknown[] = [
      "red",
      ["#ff0000"],
      { open: "red" },
      { open: "#ff00001" },
      { open: "#ff0000; x" },
      { open: 1 },
      { "bad name": "#ff0000" },
      { '"]{}': "#ff0000" },
      { ["x".repeat(65)]: "#ff0000" },
      Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`s${i}`, "#ff0000"])),
    ]
    for (const value of bad) {
      const result = await setStatusColors("a", value as Record<string, string>)
      expect({ value, success: result.success }).toEqual({ value, success: false })
    }
    expect(await readFile(registryPath, "utf-8")).toBe(before)
  })

  test("unknown workspace id fails cleanly", async () => {
    expect((await setStatusColors("nope", { open: "#ff0000" })).success).toBe(false)
    expect((await getStatusColors("nope")).success).toBe(false)
  })
})
