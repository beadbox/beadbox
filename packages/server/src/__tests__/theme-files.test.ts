import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getThemesDir, listThemeFiles, readThemeFile } from "../lib/theme-files"

let dir: string
const COLORS = {
  background: "#18181b",
  foreground: "#f4f4f5",
  card: "#27272a",
  cardForeground: "#f4f4f5",
  popover: "#27272a",
  popoverForeground: "#f4f4f5",
  primary: "#22c55e",
  primaryForeground: "#18181b",
  secondary: "#3f3f46",
  secondaryForeground: "#f4f4f5",
  muted: "#3f3f46",
  mutedForeground: "#a1a1aa",
  accent: "#3f3f46",
  accentForeground: "#f4f4f5",
  destructive: "#ef4444",
  destructiveForeground: "#fef2f2",
  border: "#3f3f46",
  input: "#3f3f46",
  ring: "#22c55e",
}
const good = (id: string) => JSON.stringify({ id, name: id, appearance: "dark", colors: COLORS })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-themes-"))
  process.env.BEADBOX_THEMES_PATH = dir
})
afterEach(async () => {
  delete process.env.BEADBOX_THEMES_PATH
  await rm(dir, { recursive: true, force: true })
})

describe("getThemesDir", () => {
  test("honours BEADBOX_THEMES_PATH", () => {
    expect(getThemesDir()).toBe(dir)
  })
})

describe("listThemeFiles", () => {
  test("returns an empty list when the directory does not exist", async () => {
    process.env.BEADBOX_THEMES_PATH = join(dir, "nope")
    expect(await listThemeFiles()).toEqual([])
  })

  test("lists valid themes with metadata and a six-colour preview, not the full token set", async () => {
    await writeFile(join(dir, "nord.json"), good("nord"))
    const list = await listThemeFiles()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe("nord")
    expect(list[0].source).toBe("user")
    expect("colors" in list[0]).toBe(false)
    expect(list[0].preview).toEqual({
      background: COLORS.background,
      card: COLORS.card,
      primary: COLORS.primary,
      secondary: COLORS.secondary,
      mutedForeground: COLORS.mutedForeground,
      foreground: COLORS.foreground,
    })
    expect(Object.keys(list[0].preview ?? {})).toHaveLength(6)
  })

  test("reports an invalid theme instead of dropping it", async () => {
    await writeFile(join(dir, "bad.json"), JSON.stringify({ id: "bad" }))
    const list = await listThemeFiles()
    expect(list).toHaveLength(1)
    expect(list[0].error).toBeTruthy()
    expect(list[0].preview).toBeUndefined()
    // No declared appearance in the file at all — null, not a guess.
    expect(list[0].appearance).toBeNull()
  })

  test("a corrupt file is reported, not fatal", async () => {
    await writeFile(join(dir, "broken.json"), "{ not json")
    await writeFile(join(dir, "nord.json"), good("nord"))
    const list = await listThemeFiles()
    expect(list).toHaveLength(2)
    expect(list.find((e) => e.id === "broken")?.error).toContain("JSON")
    expect(list.find((e) => e.id === "broken")?.appearance).toBeNull()
    expect(list.find((e) => e.id === "nord")?.error).toBeUndefined()
  })

  // final whole-plan review, Fix 2: a broken LIGHT theme must not be filed
  // under "Dark" just because validation failed before fully confirming
  // the theme — the raw, not-yet-validated JSON already names a usable
  // appearance, and losing that is exactly what put a light theme's error
  // under the wrong heading while the Light grid showed nothing wrong.
  test("preserves a validation-failed theme's own declared appearance", async () => {
    await writeFile(
      join(dir, "broken-light.json"),
      JSON.stringify({ id: "broken-light", name: "Broken Light", appearance: "light" }),
    )
    const list = await listThemeFiles()
    expect(list).toHaveLength(1)
    expect(list[0].error).toBeTruthy()
    expect(list[0].appearance).toBe("light")
  })

  test("an unparseable JSON file reports appearance as null even though it cannot be the wrong-heading bug", async () => {
    await writeFile(join(dir, "broken.json"), "{ not json")
    const list = await listThemeFiles()
    expect(list[0].appearance).toBeNull()
  })

  test("a declared appearance that isn't dark or light falls back to null, not a guess", async () => {
    await writeFile(
      join(dir, "weird.json"),
      JSON.stringify({ id: "weird", name: "Weird", appearance: "blue" }),
    )
    const list = await listThemeFiles()
    expect(list[0].error).toBeTruthy()
    expect(list[0].appearance).toBeNull()
  })

  test("ignores non-json files and subdirectories", async () => {
    await writeFile(join(dir, "notes.txt"), "hello")
    await mkdir(join(dir, "sub"))
    await writeFile(join(dir, "nord.json"), good("nord"))
    expect(await listThemeFiles()).toHaveLength(1)
  })

  test("ignores a directory whose name ends in .json", async () => {
    await mkdir(join(dir, "weird.json"))
    await writeFile(join(dir, "nord.json"), good("nord"))
    const list = await listThemeFiles()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe("nord")
  })

  test("rejects a file whose id does not match its stem", async () => {
    await writeFile(join(dir, "arctic.json"), good("nord"))
    const list = await listThemeFiles()
    expect(list[0].error).toContain("filename stem")
  })
})

describe("readThemeFile", () => {
  test("returns the full theme for a valid id", async () => {
    await writeFile(join(dir, "nord.json"), good("nord"))
    const r = await readThemeFile("nord")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theme.colors.background).toBe("#18181b")
  })

  test("refuses a path-traversal id without touching the filesystem", async () => {
    const r = await readThemeFile("../../etc/passwd")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("invalid")
  })

  test("reports a missing theme", async () => {
    const r = await readThemeFile("absent")
    expect(r.ok).toBe(false)
  })
})
