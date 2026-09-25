import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { restartWorkspaceSubscriptions, state } from "../handlers/subscribe-internals"
import { stop as stopSubscription } from "../handlers/subscribe"
import { readMetadataMode } from "../lib/change-detector"
import { resolvePort } from "../lib/workspace-health"
import { findExternalWorkspaceByDbPath } from "../lib/workspace-registry"

const previousRegistryPath = process.env.BEADBOX_REGISTRY_PATH
let root: string | undefined

afterEach(async () => {
  if (previousRegistryPath === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = previousRegistryPath
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe("external scaffold endpoint", () => {
  test("uses the registry endpoint even when the scaffold port is stale", async () => {
    root = await mkdtemp(join(tmpdir(), "beadbox-external-endpoint-"))
    const beadsDir = join(root, "workspace", ".beads")
    await mkdir(join(beadsDir, "dolt"), { recursive: true })
    await writeFile(
      join(beadsDir, "metadata.json"),
      `${JSON.stringify({ dolt_mode: "server", dolt_database: "gtp", preserved: true })}\n`,
    )
    await writeFile(join(beadsDir, "dolt-server.port"), "3307\n")
    process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
    await writeFile(
      process.env.BEADBOX_REGISTRY_PATH,
      JSON.stringify({
        version: 2,
        activeWorkspace: "external",
        workspaces: [
          {
            id: "external",
            name: "External",
            addedAt: "2026-09-24T00:00:00.000Z",
            local: { path: beadsDir },
            server: { host: "127.0.0.1", port: 14522, database: "gtp", user: "root", tls: false },
            mode: "server",
            serverOwnership: "external",
          },
        ],
      }),
    )

    const entry = findExternalWorkspaceByDbPath(join(beadsDir, "dolt"))
    expect(entry?.server?.port).toBe(14522)
    expect(resolvePort(entry!)).toBe(14522)
    expect(await readMetadataMode(join(beadsDir, "dolt"))).toBe("server")

    expect(await readFile(join(beadsDir, "dolt-server.port"), "utf-8")).toBe("3307\n")
  })

  test("restarts an active poller without changing its subscription ID", async () => {
    root = await mkdtemp(join(tmpdir(), "beadbox-subscription-restart-"))
    const path = join(root, ".beads")
    await mkdir(path)
    const subscriptionPath = join(path, "beads.db")
    const id = "external-poller-test"
    let stopped = false
    state.paths.set(id, subscriptionPath)
    state.detectors.set(id, {
      stop: async () => {
        stopped = true
      },
    })
    try {
      await restartWorkspaceSubscriptions(path)
      expect(stopped).toBe(true)
      expect(state.paths.get(id)).toBe(subscriptionPath)
      expect(state.detectors.has(id)).toBe(true)
    } finally {
      await stopSubscription(id)
    }
  })
})
