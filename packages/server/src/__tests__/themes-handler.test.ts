import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handlers } from "../handlers"
import * as themes from "../handlers/themes"
import { waitFor } from "./wait-for"

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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-themes-h-"))
  process.env.BEADBOX_THEMES_PATH = dir
})
afterEach(async () => {
  delete process.env.BEADBOX_THEMES_PATH
  await rm(dir, { recursive: true, force: true })
})

describe("themes handler", () => {
  test("is registered in the handler registry", () => {
    expect(handlers.themes).toBeDefined()
    expect(typeof handlers.themes.list).toBe("function")
    expect(typeof handlers.themes.get).toBe("function")
  })

  test("list returns user themes", async () => {
    await writeFile(
      join(dir, "nord.json"),
      JSON.stringify({ id: "nord", name: "Nord", appearance: "dark", colors: COLORS }),
    )
    const list = await themes.list()
    expect(list.map((e) => e.id)).toContain("nord")
  })

  test("get returns the full theme", async () => {
    await writeFile(
      join(dir, "nord.json"),
      JSON.stringify({ id: "nord", name: "Nord", appearance: "dark", colors: COLORS }),
    )
    const t = await themes.get("nord")
    expect(t?.colors.background).toBe("#18181b")
  })

  test("get returns null for an unknown theme rather than throwing", async () => {
    expect(await themes.get("absent")).toBeNull()
  })

  test("startWatch/stopWatch are registered and emit a stderr line on change", async () => {
    expect(typeof handlers.themes.startWatch).toBe("function")
    expect(typeof handlers.themes.stopWatch).toBe("function")

    const chunks: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = (chunk: string) => {
      chunks.push(chunk)
      return true
    }
    try {
      await themes.startWatch()
      await writeFile(join(dir, "nord.json"), "{}")
      await waitFor(() => chunks.some((c) => c.startsWith("[THEMES:changed]")), {
        description: "a [THEMES:changed] stderr line after writing a theme file",
      })
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stderr as any).write = original
      await themes.stopWatch()
    }
    expect(chunks.some((c) => c.startsWith("[THEMES:changed]"))).toBe(true)
  })

  test("stopWatch after startWatch silences further stderr lines", async () => {
    const chunks: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = (chunk: string) => {
      chunks.push(chunk)
      return true
    }
    try {
      await themes.startWatch()
      await themes.stopWatch()
      await writeFile(join(dir, "nord.json"), "{}")
      await new Promise((r) => setTimeout(r, 500))
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stderr as any).write = original
    }
    expect(chunks.some((c) => c.startsWith("[THEMES:changed]"))).toBe(false)
  })
})
