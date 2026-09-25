import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bdServeReadsEnabled, bdServeStderrLogEnabled, getAppConfigPath } from "../lib/app-config"

const previousRegistry = process.env.BEADBOX_REGISTRY_PATH
const previousOverride = process.env.BEADBOX_BD_SERVE_READS
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "beadbox-app-config-"))
  process.env.BEADBOX_REGISTRY_PATH = join(dir, "registry.json")
  delete process.env.BEADBOX_BD_SERVE_READS
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  if (previousRegistry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = previousRegistry
  if (previousOverride === undefined) delete process.env.BEADBOX_BD_SERVE_READS
  else process.env.BEADBOX_BD_SERVE_READS = previousOverride
})

test("read pilot is disabled without an app config", async () => {
  expect(getAppConfigPath()).toBe(join(dir, "config.json"))
  expect(await bdServeReadsEnabled()).toBe(false)
})

test("app config controls the pilot without restarting the sidecar", async () => {
  await writeFile(getAppConfigPath(), JSON.stringify({ bdServeReads: true }))
  expect(await bdServeReadsEnabled()).toBe(true)
  await writeFile(getAppConfigPath(), JSON.stringify({ bdServeReads: false }))
  expect(await bdServeReadsEnabled()).toBe(false)
})

test("invalid config does not enable the pilot", async () => {
  await writeFile(getAppConfigPath(), JSON.stringify({ bdServeReads: "true" }))
  expect(await bdServeReadsEnabled()).toBe(false)
  await writeFile(getAppConfigPath(), "not json")
  expect(await bdServeReadsEnabled()).toBe(false)
})

test("explicit environment override takes precedence over app config", async () => {
  await writeFile(getAppConfigPath(), JSON.stringify({ bdServeReads: true }))
  process.env.BEADBOX_BD_SERVE_READS = "0"
  expect(await bdServeReadsEnabled()).toBe(false)
  process.env.BEADBOX_BD_SERVE_READS = "1"
  expect(await bdServeReadsEnabled()).toBe(true)
})

test("bd serve stderr diagnostics require an explicit boolean setting", async () => {
  expect(await bdServeStderrLogEnabled()).toBe(false)
  await writeFile(getAppConfigPath(), JSON.stringify({ bdServeReads: true }))
  expect(await bdServeStderrLogEnabled()).toBe(false)
  await writeFile(getAppConfigPath(), JSON.stringify({ bdServeStderrLog: "true" }))
  expect(await bdServeStderrLogEnabled()).toBe(false)
  await writeFile(getAppConfigPath(), JSON.stringify({ bdServeStderrLog: true }))
  expect(await bdServeStderrLogEnabled()).toBe(true)
})
