// beadbox-01f.3: in server mode no Dolt manifest is a valid write marker.
// A stale embeddeddolt/ is a store nobody writes, and the server store's
// manifest only changes when the server starts. Either one gives the JS
// fallback one tick and then silence, so server mode returns no markers and
// the fallback is honestly inert (the poll child is the detector).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetPathCaches } from "../lib/bd-paths"
import { _testOverrides, createChangeDetector, getChangeFingerprint } from "../lib/change-detector"
import { getWorkspaceWriteMarkerPaths } from "../lib/dolt-write-marker"
import type { SubscriptionEvent } from "../subscribe-protocol"

let root: string
let beads: string

async function manifest(store: "embeddeddolt" | "dolt", db: string): Promise<string> {
  const dir = join(beads, store, db, ".dolt", "noms")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "manifest")
  await writeFile(path, `5:__DOLT__:${store}-${db}:root`)
  return path
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-01f3-"))
  beads = join(root, ".beads")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("write markers by mode (beadbox-01f.3)", () => {
  test("server mode with a stale embeddeddolt/ AND a server store selects nothing", async () => {
    await manifest("embeddeddolt", "beads")
    await manifest("dolt", "beads_nyt")
    expect(await getWorkspaceWriteMarkerPaths(beads, "server")).toEqual([])
    expect(await getChangeFingerprint(beads, "server")).toBeNull()
  })

  test("server mode with only the server store selects nothing either", async () => {
    await manifest("dolt", "beads_nyt")
    expect(await getWorkspaceWriteMarkerPaths(beads, "server")).toEqual([])
  })

  test("embedded mode is unchanged: the embeddeddolt manifest", async () => {
    const embedded = await manifest("embeddeddolt", "beads")
    await manifest("dolt", "beads_nyt")
    expect(await getWorkspaceWriteMarkerPaths(beads, "embedded")).toEqual([embedded])
    expect(await getChangeFingerprint(beads, "embedded")).toContain(embedded)
  })

  test("embedded mode on a pre-0.63 layout still uses dolt/", async () => {
    const legacy = await manifest("dolt", "beads")
    expect(await getWorkspaceWriteMarkerPaths(beads, "embedded")).toEqual([legacy])
  })
})

// Reviewer addition (eng3): the behaviour the bead is about, end to end. The
// detector's JS fallback runs in both modes; with a stale embeddeddolt/ in a
// server-mode workspace it used to emit one first-run 'change' and then go
// silent. Before this fix: 2 change events (initial + that tick). After: only
// the synthetic initial one.
describe("server-mode fallback emits no first-run tick (beadbox-01f.3)", () => {
  const originalBdPath = process.env.BD_PATH

  afterEach(() => {
    _testOverrides.pollIntervalMs = null
    if (originalBdPath === undefined) delete process.env.BD_PATH
    else process.env.BD_PATH = originalBdPath
    resetPathCaches()
  })

  test("a stale embeddeddolt/ beside a server-mode workspace", async () => {
    await manifest("embeddeddolt", "beads")
    await writeFile(join(beads, "dolt-server.port"), "3999")
    // A genuine workspace marker, so the poll loop's presence check passes.
    await writeFile(join(beads, "metadata.json"), "{}")
    // Polls always succeed with the same result, so any 'change' is the fallback's.
    const fakeBd = join(root, "bd")
    await writeFile(fakeBd, `#!/bin/sh\necho '[{"issues":"same"}]'\n`, { mode: 0o700 })
    process.env.BD_PATH = fakeBd
    resetPathCaches()
    _testOverrides.pollIntervalMs = 100

    const events: SubscriptionEvent[] = []
    const d = await createChangeDetector(beads, (e) => events.push(e), "f3-inert")
    try {
      await new Promise((r) => setTimeout(r, 1_500))
    } finally {
      await d.stop()
    }
    const changes = events.filter((e) => e.type === "change")
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ trigger: "initial" })
  })
})
