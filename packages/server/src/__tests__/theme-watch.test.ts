// Task 13: hot reload. watchThemes() watches the themes directory and
// debounces bursts of fs events into one onChange() call.
//
// Per task-13-addendum Override 1: Node's FSWatcher only emits "change",
// "error" and "close" — there is no "rename" event to register a second
// listener for — so these tests exercise a single "change" listener that
// must fire for both a file write (content change) and, implicitly, a
// create/delete (which arrives as the "rename" eventType argument to that
// same "change" listener).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchThemes } from "../lib/theme-files"
import { waitFor } from "./wait-for"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-themes-w-"))
  process.env.BEADBOX_THEMES_PATH = dir
})
afterEach(async () => {
  delete process.env.BEADBOX_THEMES_PATH
  await rm(dir, { recursive: true, force: true })
})

describe("watchThemes", () => {
  test("fires when a theme file is written", async () => {
    let fired = 0
    const stop = watchThemes(() => {
      fired++
    })
    await writeFile(join(dir, "nord.json"), "{}")
    await waitFor(() => fired > 0, {
      description: "watchThemes callback to fire after writing a theme file",
    })
    stop()
    expect(fired).toBeGreaterThan(0)
  })

  test("fires when a theme file is created then deleted (rename eventType)", async () => {
    let fired = 0
    const stop = watchThemes(() => {
      fired++
    })
    const file = join(dir, "temp.json")
    await writeFile(file, "{}")
    await waitFor(() => fired > 0, {
      description: "watchThemes callback to fire after creating a theme file",
    })
    const firedAfterCreate = fired
    await unlink(file)
    await waitFor(() => fired > firedAfterCreate, {
      description: "watchThemes callback to fire again after deleting a theme file",
    })
    stop()
    expect(fired).toBeGreaterThan(0)
  })

  test("returns a no-op stop when the directory does not exist", () => {
    process.env.BEADBOX_THEMES_PATH = join(dir, "nope")
    const stop = watchThemes(() => {})
    expect(() => stop()).not.toThrow()
  })

  test("stop() silences further events", async () => {
    let fired = 0
    const stop = watchThemes(() => {
      fired++
    })
    stop()
    await writeFile(join(dir, "nord.json"), "{}")
    await new Promise((r) => setTimeout(r, 500))
    expect(fired).toBe(0)
  })

  test("debounces a burst of writes into far fewer callbacks than writes", async () => {
    let fired = 0
    const stop = watchThemes(() => {
      fired++
    })
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, "nord.json"), JSON.stringify({ i }))
    }
    await waitFor(() => fired > 0, {
      description: "watchThemes callback to fire after a burst of writes",
    })
    stop()
    // Not asserting an exact count — the debounce makes the count
    // timing-dependent — only that coalescing actually happened.
    expect(fired).toBeGreaterThan(0)
    expect(fired).toBeLessThan(10)
  })
})
