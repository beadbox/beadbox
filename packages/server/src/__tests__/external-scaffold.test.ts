import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEnv } from "../lib/bd"
import { runRecoveryCommand } from "../handlers/recovery"
import { ensureExternalScaffold } from "../lib/external-scaffold"
import { getServerOwnership } from "../lib/workspace-registry"

const previousRegistry = process.env.BEADBOX_REGISTRY_PATH
const roots: string[] = []

afterEach(async () => {
  if (previousRegistry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = previousRegistry
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "beadbox-external-"))
  roots.push(root)
  const id = "workspace-1"
  const beadsDir = join(root, "workspaces", id, ".beads")
  await mkdir(beadsDir, { recursive: true })
  const server = { host: "127.0.0.1", port: 14522, database: "gtp", user: "root", tls: false }
  const entry = {
    id, name: "remote", addedAt: new Date().toISOString(), local: { path: beadsDir },
    server, mode: "server" as const,
  }
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
  await writeFile(process.env.BEADBOX_REGISTRY_PATH, JSON.stringify({ version: 2, activeWorkspace: id, workspaces: [entry] }))
  await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({ dolt_mode: "server", dolt_database: "gtp" }))
  await writeFile(join(beadsDir, "config.yaml"), "issue-prefix: gtp\n")
  return { beadsDir, server, entry }
}

describe("external server scaffold", () => {
  test("ownership and bd subprocess environment use the registry endpoint", async () => {
    const { beadsDir, entry } = await fixture()
    expect(getServerOwnership(entry)).toBe("external")
    const env = buildEnv({ db: join(beadsDir, "beads.db") })
    expect(env?.BEADS_DOLT_SERVER_PORT).toBe("14522")
    expect(env?.BEADS_DOLT_AUTO_START).toBe("0")
  })

  test("adopts an existing scaffold and preserves originals once", async () => {
    const { beadsDir, server } = await fixture()
    await ensureExternalScaffold(beadsDir, server)
    const metadata = JSON.parse(await readFile(join(beadsDir, "metadata.json"), "utf8"))
    expect(metadata.dolt_server_port).toBe(14522)
    expect(await readFile(join(beadsDir, "config.yaml"), "utf8")).toContain("dolt.auto-start: false")
    expect(await readFile(join(beadsDir, "metadata.json.beadbox-before-external"), "utf8")).not.toContain("dolt_server_port")
    await ensureExternalScaffold(beadsDir, server)
    expect(await readFile(join(beadsDir, "metadata.json.beadbox-before-external"), "utf8")).not.toContain("dolt_server_port")
  })

  test("recovery refuses local Dolt lifecycle commands before executing bd", async () => {
    const { beadsDir } = await fixture()
    for (const command of ["bd dolt start", "bd dolt stop", "bd init"]) {
      const result = await runRecoveryCommand(command, beadsDir)
      expect(result.success).toBe(false)
      expect(result.error).toContain("externally managed")
    }
  })
})
