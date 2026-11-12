// The long-lived poller and every immediate CLI consumer must converge on a new choice.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setBdPath } from "../handlers/bd-settings"
import { run } from "../handlers/console"
import { checkBdHealth } from "../handlers/health"
import { start, stop } from "../handlers/subscribe"
import { state } from "../handlers/subscribe-internals"
import { listBeads } from "../lib/bd"
import { resetPathCaches } from "../lib/bd-paths"

const saved = {
  BD_PATH: process.env.BD_PATH,
  BEADBOX_SETTINGS_PATH: process.env.BEADBOX_SETTINGS_PATH,
  BEADBOX_REGISTRY_PATH: process.env.BEADBOX_REGISTRY_PATH,
  BEADS_REGISTRY_PATH: process.env.BEADS_REGISTRY_PATH,
}
let root: string | undefined

afterEach(async () => {
  for (const id of [...state.detectors.keys()]) await stop(id)
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetPathCaches()
  if (root) rmSync(root, { recursive: true, force: true })
})
async function until(fn: () => boolean) {
  const end = Date.now() + 5000
  while (!fn() && Date.now() < end) await Bun.sleep(50)
  expect(fn()).toBe(true)
}
test("changing saved bd updates health, bd.ts, console and an existing subscription", async () => {
  root = mkdtempSync(join(tmpdir(), "beadbox-bd-consumers-"))
  const beads = join(root, "workspace", ".beads")
  mkdirSync(beads, { recursive: true })
  writeFileSync(
    join(beads, "metadata.json"),
    JSON.stringify({ dolt_mode: "server", dolt_database: "test" }),
  )
  process.env.BEADBOX_SETTINGS_PATH = join(root, "settings.json")
  process.env.BEADBOX_REGISTRY_PATH = join(root, "registry.json")
  process.env.BEADS_REGISTRY_PATH = join(root, "legacy.json")
  writeFileSync(
    process.env.BEADBOX_REGISTRY_PATH,
    JSON.stringify({ version: 2, activeWorkspace: null, workspaces: [] }),
  )
  delete process.env.BD_PATH
  const fake = (name: string) => {
    mkdirSync(join(root!, name), { recursive: true })
    const binary = join(root!, name, "bd")
    const log = `${binary}.log`
    writeFileSync(
      binary,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in\n *--version*) echo 'bd version 1.3.1';;\n *DOLT_HASHOF_TABLE*) echo '[{"ih":"1","ch":"1","lh":"1","dh":"1","wh":"1","wch":"1","wlh":"1","wdh":"1"}]';;\n *) echo '[]';;\nesac\n`,
      { mode: 0o700 },
    )
    return { binary, lines: () => (existsSync(log) ? readFileSync(log, "utf8") : "") }
  }
  const a = fake("first bd")
  const b = fake("second bd")
  await setBdPath(a.binary)
  const { id } = await start(beads)
  await until(() => a.lines().includes("DOLT_HASHOF_TABLE"))
  await setBdPath(b.binary)
  await until(() => b.lines().includes("DOLT_HASHOF_TABLE"))
  expect(state.detectors.has(id)).toBe(true)
  expect((await checkBdHealth()).bdPath).toBe(b.binary)
  await listBeads({ db: beads })
  await run({ args: ["status"], db: beads })
  expect(b.lines()).toContain("list")
  expect(b.lines()).toContain("status")
  const stoppedAt = a.lines()
  await Bun.sleep(1200)
  expect(a.lines()).toBe(stoppedAt)
}, 15000)

test("the pool fallback also resolves the selected bd binary", () => {
  const source = readFileSync(join(import.meta.dir, "../lib/change-detector.ts"), "utf8")
  expect(source.includes('execFile("bd",')).toBe(false)
  expect(source).toContain("execFile(resolveBdPath(), args,")
})
