// Source-local copy of lib/version-requirements.ts (P1.3 / bb-vy13.3).
// Kept verbatim — no @/ aliases, so no rewrites needed.
//
// Version requirements for Beadbox compatibility checks.
// Used by the Settings System section, incompatibility banner, and diagnostics.

export const MIN_BD_VERSION = "1.0.1"
export const MIN_DOLT_VERSION = "1.0.0"
export const RECOMMENDED_DOLT_VERSION = "1.82.0"

export type VersionStatus = "ok" | "warning" | "error" | "unknown"

export interface VersionCheck {
  tool: "beadbox" | "bd" | "dolt"
  version: string | null
  path: string | null
  status: VersionStatus
  message?: string
  upgradeCommand?: string
}

/**
 * Strip version prefixes like "bd version ", "dolt version ", "v",
 * and trailing metadata like " (dev)" or " (abc1234)".
 * Returns just the "major.minor.patch" portion.
 */
function stripVersionPrefix(raw: string): string {
  let s = raw.trim()
  // Strip known tool prefixes
  for (const prefix of ["bd version ", "dolt version "]) {
    if (s.toLowerCase().startsWith(prefix)) {
      s = s.slice(prefix.length)
      break
    }
  }
  // Strip leading "v"
  if (s.startsWith("v")) {
    s = s.slice(1)
  }
  // Strip trailing parenthetical metadata: " (dev)", " (abc1234)", etc.
  const parenIdx = s.indexOf(" (")
  if (parenIdx !== -1) {
    s = s.slice(0, parenIdx)
  }
  // Strip any remaining trailing whitespace or non-version chars
  s = s.trim()
  return s
}

/**
 * Parse a semver-like string into [major, minor, patch].
 * Returns [0, 0, 0] for unparseable input.
 */
function parseSemver(version: string): [number, number, number] {
  const parts = version.split(".")
  const major = parseInt(parts[0], 10)
  const minor = parseInt(parts[1], 10)
  const patch = parseInt(parts[2], 10)
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    return [0, 0, 0]
  }
  return [major, minor, patch]
}

/**
 * Compare two version strings numerically.
 * Strips prefixes like "bd version X", "dolt version X", "vX".
 * Returns -1 if current < minimum, 0 if equal, 1 if current > minimum.
 */
export function compareVersions(current: string, minimum: string): number {
  const [aMajor, aMinor, aPatch] = parseSemver(stripVersionPrefix(current))
  const [bMajor, bMinor, bPatch] = parseSemver(stripVersionPrefix(minimum))

  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1
  return 0
}

/**
 * Determine the version status for a tool, returning a full VersionCheck.
 * - For bd: compares against MIN_BD_VERSION
 * - For dolt: compares against MIN_DOLT_VERSION and RECOMMENDED_DOLT_VERSION
 * - For beadbox: always "ok" (the app itself)
 */
export function getVersionStatus(
  tool: "beadbox" | "bd" | "dolt",
  version: string | null,
  platform: string,
): VersionCheck {
  const base: VersionCheck = {
    tool,
    version,
    path: null,
    status: "unknown",
  }

  if (tool === "beadbox") {
    return { ...base, status: "ok" }
  }

  if (version === null || version === undefined) {
    if (tool === "dolt") {
      return {
        ...base,
        status: "error",
        message: "Dolt is installed by beads. Run: bd init",
        upgradeCommand: "bd init",
      }
    }
    return {
      ...base,
      status: "error",
      message: "Not installed",
      upgradeCommand: getUpgradeCommand(tool, platform),
    }
  }

  if (tool === "bd") {
    const cmp = compareVersions(version, MIN_BD_VERSION)
    if (cmp < 0) {
      return {
        ...base,
        status: "error",
        message: `Requires v${MIN_BD_VERSION}+`,
        upgradeCommand: getUpgradeCommand("bd", platform),
      }
    }
    return { ...base, status: "ok" }
  }

  // tool === "dolt"
  const cmpMin = compareVersions(version, MIN_DOLT_VERSION)
  if (cmpMin < 0) {
    return {
      ...base,
      status: "error",
      message: `Requires v${MIN_DOLT_VERSION}+`,
      upgradeCommand: getUpgradeCommand("dolt", platform),
    }
  }
  const cmpRec = compareVersions(version, RECOMMENDED_DOLT_VERSION)
  if (cmpRec < 0) {
    return {
      ...base,
      status: "warning",
      message: `v${RECOMMENDED_DOLT_VERSION}+ recommended`,
      upgradeCommand: getUpgradeCommand("dolt", platform),
    }
  }
  return { ...base, status: "ok" }
}

function getUpgradeCommand(tool: "bd" | "dolt", platform: string): string {
  if (platform === "darwin") {
    return tool === "bd" ? "brew upgrade beads" : "brew upgrade dolt"
  }
  if (platform === "linux") {
    return tool === "bd"
      ? "go install github.com/beadbox/beads/cmd/bd@latest"
      : "go install github.com/dolthub/dolt/go/cmd/dolt@latest"
  }
  // win32 and anything else
  return "Download from beadbox.app/download"
}
