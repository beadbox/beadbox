import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import * as healthHandlers from "../handlers/health"
import * as bd from "../lib/bd"
import { resetPathCaches, resolveBdPath, resolveBdPathWithOptions } from "../lib/bd-paths"
import { checkHealth } from "../lib/workspace-health"
import { readRegistry } from "../lib/workspace-registry"

interface BdPathInfo {
  effectivePath: string
  source: "env" | "saved" | "auto"
  envPath: string | null
  savedPath: string | null
  bdAvailable: boolean
  bdVersion: string | null
  minVersion: string
  platform: string
  statusError: string | null
  statusErrorCode: string | null
}

type SetBdPathResult =
  | { ok: true; info: BdPathInfo }
  | {
      ok: false
      code: string
      error: string
      currentVersion?: string
      requiredVersion?: string
    }

const getBdPathInfo = () =>
  (healthHandlers as unknown as { getBdPathInfo: () => Promise<BdPathInfo> }).getBdPathInfo()
const setBdPath = (p: string | null) =>
  (healthHandlers as unknown as { setBdPath: (p: string | null) => Promise<SetBdPathResult> }).setBdPath(
    p,
  )

const origBdPath = process.env.BD_PATH
const origRegistryPath = process.env.BEADBOX_REGISTRY_PATH
const origLegacyRegistryPath = process.env.BEADS_REGISTRY_PATH
const origSettingsPath = process.env.BEADBOX_SETTINGS_PATH

let sandbox: string
let settingsFile: string

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "beadbox-bd-settings-"))
  process.env.BEADBOX_REGISTRY_PATH = join(sandbox, "registry.json")
  process.env.BEADS_REGISTRY_PATH = join(sandbox, "legacy-registry.json")
  settingsFile = join(sandbox, "settings.json")
  process.env.BEADBOX_SETTINGS_PATH = settingsFile
  delete process.env.BD_PATH
  resetPathCaches()
})

afterEach(async () => {
  if (origBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = origBdPath
  if (origRegistryPath === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = origRegistryPath
  if (origLegacyRegistryPath === undefined) delete process.env.BEADS_REGISTRY_PATH
  else process.env.BEADS_REGISTRY_PATH = origLegacyRegistryPath
  if (origSettingsPath === undefined) delete process.env.BEADBOX_SETTINGS_PATH
  else process.env.BEADBOX_SETTINGS_PATH = origSettingsPath
  resetPathCaches()
  if (sandbox) {
    await rm(sandbox, { recursive: true, force: true })
  }
})

async function makeFakeBd(
  filePath: string,
  version = "1.3.4",
  mode = 0o755,
  markerLog?: string,
): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true })
  const logLine = markerLog ? `echo "${filePath}" >> "${markerLog}"\n` : ""
  const script = [
    "#!/bin/sh",
    logLine,
    'case "$1" in',
    `  --version) echo "bd version ${version}" ;;`,
    `  version) echo '{"version":"${version}"}' ;;`,
    "  *) echo '[]' ;;",
    "esac",
    "",
  ].join("\n")
  await writeFile(filePath, script)
  await chmod(filePath, mode)
  return filePath
}

describe("saved per-user bd path — precedence, lifecycle, and live switching", () => {
  test("accepts and persists a saved path containing spaces across cache resets", async () => {
    const spacedBd = await makeFakeBd(join(sandbox, "My Developer Tools", "beads cli", "bd"), "1.3.4")

    const res = await setBdPath(spacedBd)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.info.source).toBe("saved")
    expect(res.info.effectivePath).toBe(spacedBd)
    expect(res.info.savedPath).toBe(spacedBd)
    expect(res.info.bdVersion).toBe("1.3.4")
    expect(resolveBdPath()).toBe(spacedBd)

    if (process.platform !== "win32") {
      const st = await stat(settingsFile)
      expect(st.mode & 0o777).toBe(0o600)
    }

    // Simulate sidecar restart by clearing in-memory caches; settings.json on disk still wins
    resetPathCaches()
    expect(resolveBdPath()).toBe(spacedBd)
    const afterRestart = await getBdPathInfo()
    expect(afterRestart.source).toBe("saved")
    expect(afterRestart.effectivePath).toBe(spacedBd)
    expect(afterRestart.savedPath).toBe(spacedBd)
  })

  test("rejects too-old, missing, non-executable, and directory paths on setBdPath", async () => {
    const oldBd = await makeFakeBd(join(sandbox, "old", "bd"), "1.0.4")
    const oldRes = await setBdPath(oldBd)
    expect(oldRes).toMatchObject({
      ok: false,
      code: "version_too_old",
      currentVersion: "1.0.4",
      requiredVersion: "1.1.0",
    })

    const missingRes = await setBdPath(join(sandbox, "missing", "bd"))
    expect(missingRes).toMatchObject({ ok: false, code: "not_found" })

    const dirPath = join(sandbox, "a-directory")
    await mkdir(dirPath, { recursive: true })
    const dirRes = await setBdPath(dirPath)
    expect(dirRes).toMatchObject({ ok: false, code: "not_regular_file" })

    if (process.platform !== "win32") {
      const nonExecBd = await makeFakeBd(join(sandbox, "nonexec", "bd"), "1.3.4", 0o644)
      const nonExecRes = await setBdPath(nonExecBd)
      expect(nonExecRes).toMatchObject({ ok: false, code: "not_executable" })
    }
  })

  test("surfaces clear error state when a previously saved binary later becomes too-old, missing, or non-executable", async () => {
    const wsRoot = join(sandbox, "workspace")
    await mkdir(join(wsRoot, ".beads"), { recursive: true })
    await writeFile(join(wsRoot, ".beads", "metadata.json"), "{}")
    const wsEntry = {
      id: "3f1b8a24-0000-4000-8000-000000007701",
      name: "proj",
      addedAt: "2026-11-12T00:00:00.000Z",
      local: { path: join(wsRoot, ".beads") },
      server: null,
      mode: "embedded" as const,
    }

    const customBd = await makeFakeBd(join(sandbox, "mutable", "bd"), "1.3.4")
    expect((await setBdPath(customBd)).ok).toBe(true)
    expect(await checkHealth(wsEntry)).toMatchObject({ ok: true, bdPath: customBd })

    // Downgraded on disk after save
    await makeFakeBd(customBd, "1.0.4")
    const oldHealth = await checkHealth(wsEntry)
    expect(oldHealth).toMatchObject({
      ok: false,
      error: { kind: "bd_version_too_old", current: "1.0.4", required: "1.1.0" },
    })
    expect(await getBdPathInfo()).toMatchObject({
      source: "saved",
      savedPath: customBd,
      statusErrorCode: "version_too_old",
    })

    // Non-executable on disk after save
    if (process.platform !== "win32") {
      await chmod(customBd, 0o644)
      const nonExecHealth = await checkHealth(wsEntry)
      expect(nonExecHealth).toMatchObject({
        ok: false,
        error: { kind: "bd_missing" },
      })
      expect(await getBdPathInfo()).toMatchObject({
        source: "saved",
        savedPath: customBd,
        bdAvailable: false,
        statusErrorCode: "not_executable",
      })
    }

    // Deleted on disk after save
    await rm(customBd, { force: true })
    const missingHealth = await checkHealth(wsEntry)
    expect(missingHealth).toMatchObject({
      ok: false,
      error: { kind: "bd_missing" },
    })
    expect(await getBdPathInfo()).toMatchObject({
      source: "saved",
      savedPath: customBd,
      bdAvailable: false,
      statusErrorCode: "not_found",
    })
  })

  test("BD_PATH env override wins over saved path and auto-detection, and reset to auto clears saved path", async () => {
    const autoHome = join(sandbox, "home")
    const sysRoot = join(sandbox, "sys")
    await mkdir(autoHome, { recursive: true })
    await mkdir(sysRoot, { recursive: true })

    const autoBd = await makeFakeBd(join(autoHome, ".local", "share", "mise", "shims", "bd"), "1.2.0")
    const savedBd = await makeFakeBd(join(sandbox, "saved", "bd"), "1.3.0")
    const envBd = await makeFakeBd(join(sandbox, "env", "bd"), "1.3.4")

    expect((await setBdPath(savedBd)).ok).toBe(true)

    // Saved beats auto
    expect(
      resolveBdPathWithOptions({
        env: {},
        home: autoHome,
        platform: "darwin",
        systemRoot: sysRoot,
        settingsPath: settingsFile,
      }),
    ).toBe(savedBd)

    // BD_PATH env beats saved, and getBdPathInfo reports source="env" while keeping savedPath visible
    process.env.BD_PATH = envBd
    resetPathCaches()
    expect(resolveBdPath()).toBe(envBd)
    const envInfo = await getBdPathInfo()
    expect(envInfo.source).toBe("env")
    expect(envInfo.effectivePath).toBe(envBd)
    expect(envInfo.envPath).toBe(envBd)
    expect(envInfo.savedPath).toBe(savedBd)
    expect(envInfo.bdVersion).toBe("1.3.4")

    // Clear BD_PATH -> saved wins again
    delete process.env.BD_PATH
    resetPathCaches()
    expect(resolveBdPath()).toBe(savedBd)

    // Reset to automatic detection (setBdPath(null)) -> auto wins
    const resetRes = await setBdPath(null)
    expect(resetRes.ok).toBe(true)
    if (!resetRes.ok) return
    expect(resetRes.info.source).toBe("auto")
    expect(resetRes.info.savedPath).toBeNull()
    expect(
      resolveBdPathWithOptions({
        env: {},
        home: autoHome,
        platform: "darwin",
        systemRoot: sysRoot,
        settingsPath: settingsFile,
      }),
    ).toBe(autoBd)
  })

  test("switches live bd callers immediately without sidecar restart and never writes per-repo state", async () => {
    const callLog = join(sandbox, "calls.log")
    const bdOne = await makeFakeBd(join(sandbox, "one", "bd"), "1.3.1", 0o755, callLog)
    const bdTwo = await makeFakeBd(join(sandbox, "two", "bd"), "1.3.4", 0o755, callLog)

    const wsBeads = join(sandbox, "repo", ".beads")
    await mkdir(wsBeads, { recursive: true })
    await writeFile(join(wsBeads, "metadata.json"), JSON.stringify({ dolt_mode: "embedded" }))

    expect((await setBdPath(bdOne)).ok).toBe(true)
    await bd.listBeads({ db: join(wsBeads, "beads.db") })
    expect((await healthHandlers.getToolVersions()).bd_version).toBe("1.3.1")
    const logAfterOne = await readFile(callLog, "utf-8")
    expect(logAfterOne).toContain(bdOne)
    expect(logAfterOne).not.toContain(bdTwo)

    // Switch at runtime without restarting sidecar
    expect((await setBdPath(bdTwo)).ok).toBe(true)
    await bd.listBeads({ db: join(wsBeads, "beads.db") })
    expect((await healthHandlers.getToolVersions()).bd_version).toBe("1.3.4")
    const logAfterTwo = await readFile(callLog, "utf-8")
    expect(logAfterTwo).toContain(bdTwo)

    // Verify neither registry.json nor workspace .beads holds per-repo bdPath
    const reg = await readRegistry()
    expect("bdPath" in (reg as unknown as Record<string, unknown>)).toBe(false)
  })
})
