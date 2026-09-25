// Whether a workspace's reads may go through `bd serve` (the opt-in pilot,
// beadbox-6x2). Pure: the caller supplies the platform and the bd version, so
// this does no I/O and spawns nothing. Anything ineligible reads through the
// CLI exactly as it does today.
//
// Checked in a fixed order so the reported reason is the first blocker a user
// would need to clear.

import type { RegistryEntry } from "./workspace-registry"
import { SERVE_MIN_BD_VERSION } from "./version-requirements"

export type ServeIneligibleReason =
  | "not-opted-in"
  | "embedded"
  | "no-local-scaffold"
  | "windows"
  | "bd-version-unknown"
  | "bd-too-old"
  | "disabled"

export type ServeEligibility =
  | { eligible: true }
  | { eligible: false; reason: ServeIneligibleReason; detail?: string }

export interface ServeEligibilityContext {
  platform: NodeJS.Platform
  /** Raw `bd --version` output or a bare version; null when it could not be read. */
  bdVersion: string | null
  /** Set once an integrity failure (identity, auth, contract) disables serve for this workspace. */
  disabledReason?: string
}

type Version = { core: [number, number, number]; prerelease: boolean }

// Strict: "1.3.0", "v1.3.0-rc.2", "bd version 1.3.0 (f45b249ce)". Anything
// without a full major.minor.patch is unknown, never "old": the shared
// compareVersions maps garbage to 0.0.0, which would misreport it.
function parseVersion(raw: string): Version | null {
  const m = /(?:^|[\s v])(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?=$|[\s(])/.exec(raw.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] !== undefined }
}

/** Semver order: a prerelease sorts below its own release, so 1.3.0-rc.2 < 1.3.0. */
function atLeast(v: Version, min: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (v.core[i] !== min.core[i]) return v.core[i] > min.core[i]
  }
  return !v.prerelease || min.prerelease
}

export function serveReadEligibility(
  entry: Pick<RegistryEntry, "serveReads" | "mode" | "local">,
  ctx: ServeEligibilityContext,
): ServeEligibility {
  // Only a literal true: the registry is read without type validation.
  if (entry.serveReads !== true) return { eligible: false, reason: "not-opted-in" }
  // bd serve refuses embedded Dolt.
  if (entry.mode !== "server") return { eligible: false, reason: "embedded" }
  // A scaffold-less server:// entry has no directory to run bd serve in.
  if (!entry.local?.path) return { eligible: false, reason: "no-local-scaffold" }
  // Ruled CLI-only: the lifetime tie needs /bin/sh.
  if (ctx.platform === "win32") return { eligible: false, reason: "windows" }
  const version = ctx.bdVersion === null ? null : parseVersion(ctx.bdVersion)
  if (!version) {
    return { eligible: false, reason: "bd-version-unknown", detail: ctx.bdVersion ?? undefined }
  }
  const min = parseVersion(SERVE_MIN_BD_VERSION)
  if (!min) throw new Error(`SERVE_MIN_BD_VERSION is not a version: ${SERVE_MIN_BD_VERSION}`)
  if (!atLeast(version, min)) {
    return { eligible: false, reason: "bd-too-old", detail: ctx.bdVersion ?? undefined }
  }
  if (ctx.disabledReason) return { eligible: false, reason: "disabled", detail: ctx.disabledReason }
  return { eligible: true }
}
