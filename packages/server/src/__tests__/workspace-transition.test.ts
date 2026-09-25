import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetPathCaches } from "../lib/bd-paths"
import type { RegistryEntry, WorkspaceRegistry } from "../lib/workspace-registry"
import { WorkspaceTransition } from "../lib/workspace-transition"

const dirs: string[] = []
const oldRegistry = process.env.BEADBOX_REGISTRY_PATH
const oldBdPath = process.env.BD_PATH

afterEach(async () => {
  if (oldRegistry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = oldRegistry
  if (oldBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = oldBdPath
  resetPathCaches()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function entry(
  id: string,
  server?: RegistryEntry["server"],
  local: string | null = null,
): RegistryEntry {
  return {
    id,
    name: id,
    addedAt: new Date(0).toISOString(),
    local: local ? { path: local } : null,
    server: server ?? null,
    mode: server ? "server" : "embedded",
  }
}

async function registry(workspaces: RegistryEntry[]): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "beadbox-transition-"))
  dirs.push(dir)
  process.env.BEADBOX_REGISTRY_PATH = join(dir, "registry.json")
  await writeFile(
    process.env.BEADBOX_REGISTRY_PATH,
    JSON.stringify({
      version: 2,
      activeWorkspace: null,
      workspaces,
    } satisfies WorkspaceRegistry),
  )
}

test("storage transition drains all SQL aliases before mutation and advances generations", async () => {
  const server = { host: "localhost", port: 3307, database: "beads", user: "root", tls: false }
  await registry([
    entry("a", server),
    entry("b", { ...server, host: "127.0.0.1", user: "other", tls: true }),
    entry("c", { ...server, database: "other" }),
  ])
  const events: string[] = []
  const coordinator = new WorkspaceTransition({
    async stopServe(id) {
      events.push(`stop:${id}`)
    },
    async pauseSubscriptions(entries) {
      events.push(`pause:${entries.map((item) => item.id).join(",")}`)
      return async () => {
        events.push("resume")
      }
    },
  })
  const lease = await coordinator.acquire("b")
  let releaseMutation!: () => void
  const mutationReady = new Promise<void>((resolve) => {
    releaseMutation = resolve
  })
  const transition = coordinator.runStorageTransition("a", async () => {
    events.push("mutate")
    await mutationReady
  })
  await Bun.sleep(10)
  expect(events).toEqual([])
  lease.release()
  await Bun.sleep(10)
  expect(events).toEqual(["pause:a,b", "stop:a", "stop:b", "mutate"])
  let acquired = false
  const next = coordinator.acquire("a").then((value) => {
    acquired = true
    value.release()
  })
  await Bun.sleep(10)
  expect(acquired).toBe(false)
  releaseMutation()
  await transition
  await next
  expect(events).toEqual(["pause:a,b", "stop:a", "stop:b", "mutate", "resume"])
  expect(coordinator.generation("a")).toBe(1)
  expect(coordinator.generation("b")).toBe(1)
  expect(coordinator.generation("c")).toBe(0)
})

test("physical local aliases share one transition barrier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beadbox-transition-local-"))
  dirs.push(dir)
  const beads = join(dir, ".beads")
  const alias = join(dir, "alias")
  await mkdir(beads)
  await symlink(beads, alias)
  await registry([entry("a", undefined, beads), entry("b", undefined, alias)])
  const stopped: string[] = []
  const coordinator = new WorkspaceTransition({
    async stopServe(id) {
      stopped.push(id)
    },
    async pauseSubscriptions() {
      return async () => {}
    },
  })
  await coordinator.runStorageTransition("a", async () => {})
  expect(stopped).toEqual(["a", "b"])
})

test("nested operation keeps its lease while a transition waits", async () => {
  const server = { host: "localhost", port: 3307, database: "beads", user: "root", tls: false }
  await registry([entry("a", server)])
  const events: string[] = []
  const coordinator = new (class extends WorkspaceTransition {
    override async preflightBdBinary(): Promise<void> {}
  })({
    async stopServe() {
      events.push("stop")
    },
    async pauseSubscriptions() {
      return async () => {}
    },
  })
  let transition!: Promise<void>
  await coordinator.withOperation("a", async () => {
    transition = coordinator.runStorageTransition("a", async () => {
      events.push("mutate")
    })
    await Bun.sleep(10)
    await coordinator.withOperation("a", async () => {
      events.push("nested")
    })
    expect(events).toEqual(["nested"])
  })
  await transition
  expect(events).toEqual(["nested", "stop", "mutate"])
})

test("binary replacement waits for an active operation before stopping serve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beadbox-transition-binary-"))
  dirs.push(dir)
  const binary = join(dir, "bd")
  await writeFile(binary, "#!/bin/sh\necho bd 1.3.0\n")
  await chmod(binary, 0o755)
  process.env.BD_PATH = binary
  resetPathCaches()
  await registry([
    entry("a", { host: "localhost", port: 3307, database: "beads", user: "root", tls: false }),
  ])
  const events: string[] = []
  const coordinator = new WorkspaceTransition({
    async stopServe(id) {
      events.push(`stop:${id}`)
    },
    async pauseSubscriptions() {
      return async () => {}
    },
  })
  await coordinator.preflightBdBinary()
  expect(await coordinator.bdVersion()).toBe("bd 1.3.0")
  const lease = await coordinator.acquire("a")
  await writeFile(binary, "#!/bin/sh\necho bd 1.3.1\n")
  const preflight = coordinator.preflightBdBinary()
  await Bun.sleep(10)
  expect(events).toEqual([])
  lease.release()
  await preflight
  expect(await coordinator.bdVersion()).toBe("bd 1.3.1")
  expect(events).toEqual(["stop:a"])
  expect(coordinator.generation("a")).toBe(1)
})
