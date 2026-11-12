import { randomBytes } from "node:crypto"
import { constants, readFileSync } from "node:fs"
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

import { execFileAsync } from "./exec"
import { compareVersions, MIN_BD_VERSION } from "./version-requirements"
import { getBeadboxRegistryPath } from "./workspace-registry"

export interface UserSettingsFile {
  version: 1
  bdPath?: string | null
}

export type BdValidationErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_regular_file"
  | "not_executable"
  | "probe_timeout"
  | "probe_failed"
  | "version_too_old"

export type BdValidationResult =
  | {
      ok: true
      normalizedPath: string
      version: string
    }
  | {
      ok: false
      code: BdValidationErrorCode
      error: string
      normalizedPath?: string
      currentVersion?: string
      requiredVersion?: string
    }

export type BdProbeOutcome =
  | { ok: true; version: string }
  | { ok: false; kind: "timeout" | "failed"; detail: string }

const BD_STRICT_VERSION_RE = /\bbd(?:\.exe)?\s+version\s+v?(\d+\.\d+\.\d+)/i

function expandHomeWith(raw: string, home: string): string {
  if (raw === "~") return home
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return join(home, raw.slice(2))
  }
  return raw
}

/**
 * Per-user settings file (~/.beadbox/settings.json).
 * Never stored per repository; defaults alongside getBeadboxRegistryPath() so
 * sandboxed tests setting BEADBOX_REGISTRY_PATH stay isolated automatically.
 */
export function getBdSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BEADBOX_SETTINGS_PATH?.trim()
  if (override && !override.includes("\0")) {
    const home = env.HOME?.trim() || homedir()
    return expandHomeWith(override, home)
  }
  return join(dirname(getBeadboxRegistryPath()), "settings.json")
}

/**
 * Normalize and structurally validate a raw path string (no NUL bytes,
 * leading ~/ expanded, must be absolute). Preserves internal spaces.
 */
export function normalizeAbsoluteCandidatePath(
  raw: unknown,
  home: string = process.env.HOME?.trim() || homedir(),
): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.includes("\0")) return null
  const expanded = expandHomeWith(trimmed, home)
  if (!isAbsolute(expanded)) return null
  return expanded
}

/**
 * Synchronously read the saved per-user bd path for resolveBdPath().
 * Corrupt or relative values on disk are ignored rather than returned.
 */
export function readSavedBdPathSync(
  settingsPath: string = getBdSettingsPath(),
  home: string = process.env.HOME?.trim() || homedir(),
): string | null {
  try {
    const raw = readFileSync(settingsPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<UserSettingsFile>
    if (!parsed || typeof parsed !== "object") return null
    return normalizeAbsoluteCandidatePath(parsed.bdPath, home)
  } catch {
    return null
  }
}

let writeQueue: Promise<void> = Promise.resolve()

async function readSettingsObject(settingsPath: string): Promise<UserSettingsFile> {
  try {
    const raw = await readFile(settingsPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<UserSettingsFile>
    if (parsed && typeof parsed === "object") {
      return {
        version: 1,
        ...(typeof parsed.bdPath === "string" ? { bdPath: parsed.bdPath } : {}),
      }
    }
  } catch {
    // Missing or unreadable file starts fresh
  }
  return { version: 1 }
}

/**
 * Atomically persist or clear (`null`) the per-user bd path in settings.json
 * with 0600 permissions.
 */
export function writeSavedBdPath(
  bdPath: string | null,
  settingsPath: string = getBdSettingsPath(),
): Promise<void> {
  const next = writeQueue.then(async () => {
    const dir = dirname(settingsPath)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const existing = await readSettingsObject(settingsPath)
    const payload: UserSettingsFile = { ...existing, version: 1 }
    if (bdPath === null) {
      delete payload.bdPath
    } else {
      payload.bdPath = bdPath
    }
    const tmpPath = `${settingsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    const serialized = `${JSON.stringify(payload, null, 2)}\n`
    try {
      await writeFile(tmpPath, serialized, { encoding: "utf-8", mode: 0o600, flag: "wx" })
      if (process.platform !== "win32") {
        await chmod(tmpPath, 0o600)
      }
      await rename(tmpPath, settingsPath)
    } catch (err) {
      await unlink(tmpPath).catch(() => {})
      throw err
    }
  })
  writeQueue = next.catch(() => {})
  return next
}

/**
 * Run `<bdPath> --version` directly via execFileAsync (no shell) with a strict timeout.
 */
export async function probeBdBinary(
  bdPath: string,
  timeoutMs = 5_000,
): Promise<BdProbeOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(bdPath, ["--version"], {
      timeout: timeoutMs,
      windowsHide: true,
    })
    const combined = `${stdout}\n${stderr}`
    const match = combined.match(BD_STRICT_VERSION_RE)
    if (!match) {
      return {
        ok: false,
        kind: "failed",
        detail: "Executable did not report a valid bd version string.",
      }
    }
    return { ok: true, version: match[1] }
  } catch (err: unknown) {
    const e = err as { killed?: boolean; code?: string; signal?: string; message?: string }
    if (e?.killed === true || e?.code === "ETIMEDOUT" || e?.signal === "SIGTERM") {
      return {
        ok: false,
        kind: "timeout",
        detail: `Timed out running --version after ${timeoutMs}ms.`,
      }
    }
    return {
      ok: false,
      kind: "failed",
      detail: e?.message ?? String(err),
    }
  }
}

/**
 * Validate a user-supplied custom bd binary path:
 * 1. Non-empty string, no NUL bytes, leading ~/ expanded, must be absolute.
 * 2. Regular file on disk (follows symlinks via stat).
 * 3. Executable bit set on Unix (access X_OK).
 * 4. `<path> --version` succeeds within timeout (no shell) and meets MIN_BD_VERSION.
 */
export async function validateBdBinary(
  rawInput: string,
  options: { home?: string; platform?: NodeJS.Platform; probeTimeoutMs?: number } = {},
): Promise<BdValidationResult> {
  const home = options.home ?? (process.env.HOME?.trim() || homedir())
  const platform = options.platform ?? process.platform
  const normalized = normalizeAbsoluteCandidatePath(rawInput, home)
  if (!normalized) {
    return {
      ok: false,
      code: "invalid_path",
      error: "Enter an absolute path to the bd executable.",
    }
  }

  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(normalized)
  } catch {
    return {
      ok: false,
      code: "not_found",
      normalizedPath: normalized,
      error: `No file found at ${normalized}.`,
    }
  }

  if (!st.isFile()) {
    return {
      ok: false,
      code: "not_regular_file",
      normalizedPath: normalized,
      error: st.isDirectory()
        ? `${normalized} is a directory. Specify the bd executable file itself.`
        : `${normalized} is not a regular file.`,
    }
  }

  if (platform !== "win32") {
    try {
      await access(normalized, constants.X_OK)
    } catch {
      return {
        ok: false,
        code: "not_executable",
        normalizedPath: normalized,
        error: `${normalized} is not executable (check file permissions with chmod +x).`,
      }
    }
  }

  const probe = await probeBdBinary(normalized, options.probeTimeoutMs ?? 5_000)
  if (!probe.ok) {
    return {
      ok: false,
      code: probe.kind === "timeout" ? "probe_timeout" : "probe_failed",
      normalizedPath: normalized,
      error:
        probe.kind === "timeout"
          ? `Timed out running ${normalized} --version.`
          : `${normalized} is not a valid bd executable (${probe.detail}).`,
    }
  }

  if (compareVersions(probe.version, MIN_BD_VERSION) < 0) {
    return {
      ok: false,
      code: "version_too_old",
      normalizedPath: normalized,
      currentVersion: probe.version,
      requiredVersion: MIN_BD_VERSION,
      error: `bd v${MIN_BD_VERSION} or later is required (found v${probe.version} at ${normalized}).`,
    }
  }

  return {
    ok: true,
    normalizedPath: normalized,
    version: probe.version,
  }
}
