// beadbox-dr6: ONE answer to "is this workspace embedded or server?".
//
// Live defect: an embedded workspace (metadata dolt_mode=embedded) that also
// had a dolt-server.port (a real server started on its legacy dolt/ store) and
// a registry entry from a server-mode past. The change detector answered
// "server" (port file first), bd.ts answered "embedded" (metadata first), bd
// refused the poll child's `bd sql` ("not yet supported in embedded mode"),
// and live updates were dead forever. bd itself follows metadata.json, so an
// explicit dolt_mode there wins over any port file or registry entry.
//
// Synthetic workspaces and a synthetic registry (BEADBOX_REGISTRY_PATH) only.

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as bd from "../lib/bd"
import * as detector from "../lib/change-detector"
import * as metadata from "../lib/dolt-metadata"
import type { SubscriptionEvent } from "../subscribe-protocol"

setDefaultTimeout(30_000)

const originalRegistry = process.env.BEADBOX_REGISTRY_PATH
let root: string
let registryPath: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-dr6-"))
  registryPath = join(root, "registry.json")
  process.env.BEADBOX_REGISTRY_PATH = registryPath
})

afterAll(async () => {
  if (originalRegistry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = originalRegistry
  await rm(root, { recursive: true, force: true })
})

afterEach(() => {
  detector._testOverrides.embeddedDebounceMs = null
  detector._testOverrides.pollIntervalMs = null
})

type Meta = "embedded" | "server" | "absent" | "unparseable"

async function workspace(
  name: string,
  opts: { meta: Meta; port: boolean; registryExternal: boolean },
): Promise<string> {
  const beads = join(root, name, ".beads")
  await mkdir(beads, { recursive: true })
  if (opts.meta === "embedded" || opts.meta === "server") {
    await writeFile(
      join(beads, "metadata.json"),
      JSON.stringify({ backend: "dolt", dolt_mode: opts.meta }),
    )
  } else if (opts.meta === "unparseable") {
    await writeFile(join(beads, "metadata.json"), "{not json")
  }
  if (opts.port) await writeFile(join(beads, "dolt-server.port"), "58625")
  const registry = { version: 2, activeWorkspace: null, workspaces: [] as unknown[] }
  try {
    Object.assign(registry, JSON.parse(await readFile(registryPath, "utf8")))
  } catch {
    /* first entry */
  }
  if (opts.registryExternal) {
    registry.workspaces.push({
      id: `dr6-${name}`,
      name,
      addedAt: "2026-05-01T00:00:00Z",
      local: { path: beads },
      server: { host: "127.0.0.1", port: 3307, database: "bb", user: "root" },
      mode: "server",
      serverOwnership: "external",
    })
  }
  await writeFile(registryPath, JSON.stringify(registry))
  return beads
}

// bd's rule: an explicit metadata dolt_mode wins; otherwise a server hint
// (an external registry entry or a valid port file) means server.
function expected(o: {
  meta: Meta
  port: boolean
  registryExternal: boolean
}): "embedded" | "server" {
  if (o.meta === "embedded" || o.meta === "server") return o.meta
  return o.registryExternal || o.port ? "server" : "embedded"
}

describe("every mode oracle agrees, on every combination (AC4)", () => {
  const combos: Array<{ meta: Meta; port: boolean; registryExternal: boolean }> = []
  for (const meta of ["embedded", "server", "absent", "unparseable"] as Meta[])
    for (const port of [true, false])
      for (const registryExternal of [true, false]) combos.push({ meta, port, registryExternal })

  test.each(combos)("metadata=%p", async (combo) => {
    const name = `${combo.meta}-${combo.port ? "port" : "noport"}-${combo.registryExternal ? "reg" : "noreg"}`
    const beads = await workspace(name, combo)
    const want = expected(combo)
    const dbPath = join(beads, "beads.db")
    expect({ oracle: "change-detector", mode: await detector.readMetadataMode(dbPath) }).toEqual({
      oracle: "change-detector",
      mode: want,
    })
    expect({ oracle: "dolt-metadata", mode: await metadata.readMetadataMode(dbPath) }).toEqual({
      oracle: "dolt-metadata",
      mode: want,
    })
    expect({
      oracle: "bd.isEmbeddedMode",
      mode: bd.isEmbeddedMode(dbPath) ? "embedded" : "server",
    }).toEqual({
      oracle: "bd.isEmbeddedMode",
      mode: want,
    })
  })
})

describe("the live case: embedded store + stale port file + registry mode=server (AC1-AC3)", () => {
  test("the detector runs EMBEDDED: no poll child, and a write is delivered", async () => {
    const beads = await workspace("live", { meta: "embedded", port: true, registryExternal: true })
    const manifest = join(beads, "embeddeddolt", "beadbox", ".dolt", "noms", "manifest")
    await mkdir(join(manifest, ".."), { recursive: true })
    await writeFile(manifest, "5:__DOLT__:root-before")
    detector._testOverrides.embeddedDebounceMs = 50
    detector._testOverrides.pollIntervalMs = 200

    const events: SubscriptionEvent[] = []
    const lines: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(String(chunk))
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write
    let d: Awaited<ReturnType<typeof detector.createChangeDetector>> | undefined
    try {
      d = await detector.createChangeDetector(
        join(beads, "beads.db"),
        (e) => events.push(e),
        "dr6-live",
      )
      expect(lines.some((l) => l.includes("(mode: embedded"))).toBe(true)
      await new Promise((r) => setTimeout(r, 300))
      // The real bd write pattern: the Dolt commit rewrites the manifest.
      await writeFile(manifest, "5:__DOLT__:root-after-bd-close")
      const deadline = Date.now() + 5_000
      while (
        Date.now() < deadline &&
        !events.some((e) => e.type === "change" && e.trigger !== "initial")
      ) {
        await new Promise((r) => setTimeout(r, 50))
      }
    } finally {
      process.stderr.write = write
      await d?.stop()
    }
    expect(events.some((e) => e.type === "change" && e.trigger !== "initial")).toBe(true)
    expect(
      lines.some((l) => l.includes("pollChild") || l.includes("[SUBSCRIPTION:dr6-live]")),
    ).toBe(false)
  })

  test("a true server workspace is unchanged: server mode", async () => {
    const beads = await workspace("true-server", {
      meta: "server",
      port: true,
      registryExternal: false,
    })
    expect(await detector.readMetadataMode(join(beads, "beads.db"))).toBe("server")
    expect(bd.isEmbeddedMode(join(beads, "beads.db"))).toBe(false)
  })
})
