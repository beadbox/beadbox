import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getBeadboxRegistryPath } from "./workspace-registry"

const warnedPaths = new Set<string>()

export function getAppConfigPath(): string {
  return join(dirname(getBeadboxRegistryPath()), "config.json")
}

function warnOnce(path: string, setting: string): void {
  const key = `${path}:${setting}`
  if (warnedPaths.has(key)) return
  warnedPaths.add(key)
  console.warn(`[beadbox-config] ${path}: invalid ${setting} setting; disabled`)
}

async function booleanSetting(setting: string): Promise<boolean> {
  const path = getAppConfigPath()
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    warnOnce(path, setting)
    return false
  }

  try {
    const config: unknown = JSON.parse(raw)
    if (config && typeof config === "object" && !Array.isArray(config)) {
      const enabled = (config as Record<string, unknown>)[setting]
      if (enabled === undefined) return false
      if (typeof enabled === "boolean") return enabled
    }
  } catch {
    // Invalid JSON is handled like an invalid setting below.
  }
  warnOnce(path, setting)
  return false
}

/** Optional read pilot. The environment variable remains an explicit override. */
export async function bdServeReadsEnabled(): Promise<boolean> {
  if (process.env.BEADBOX_BD_SERVE_READS === "1") return true
  if (process.env.BEADBOX_BD_SERVE_READS === "0") return false
  return booleanSetting("bdServeReads")
}

/** Capture only bd serve stderr; the general sidecar log never receives it. */
export async function bdServeStderrLogEnabled(): Promise<boolean> {
  return booleanSetting("bdServeStderrLog")
}
