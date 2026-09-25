// beadbox-ag1: brew is macOS-only. Every bd upgrade hint the sidecar produces
// (bd error fixes, the diagnostics message) goes through bdUpgradeHint, which
// may name brew for "darwin" and for nothing else: not Linux, not Windows,
// not a platform it doesn't recognise. brew as the fall-through has
// regressed four times.

import { describe, expect, test } from "bun:test"
import { diagnosticsUnsupportedMessage } from "../handlers/diagnostics"
import { toBdLoadError } from "../lib/bd-error"
import { bdUpgradeHint } from "../lib/version-requirements"

const GO_INSTALL =
  "CGO_ENABLED=1 GOFLAGS=-tags=gms_pure_go go install github.com/steveyegge/beads/cmd/bd@latest"
const NOT_MAC = ["linux", "win32", "freebsd", ""]

describe("bdUpgradeHint", () => {
  test("macOS gets brew", () => {
    expect(bdUpgradeHint("darwin").fixCommand).toBe("brew upgrade beads")
  })

  test("Linux gets beads' documented embedded-capable go install", () => {
    expect(bdUpgradeHint("linux").fixCommand).toBe(GO_INSTALL)
  })

  test.each(NOT_MAC)("platform %p never gets brew", (platform) => {
    expect(JSON.stringify(bdUpgradeHint(platform))).not.toContain("brew")
  })

  test.each([
    "win32",
    "freebsd",
    "",
  ])("platform %p gets the releases page, no command", (platform) => {
    const hint = bdUpgradeHint(platform)
    expect(hint.fixCommand).toBeNull()
    expect(hint.fixDescription).toContain("github.com/steveyegge/beads/releases")
  })
})

describe("diagnostics 'unsupported' message", () => {
  test("macOS names brew", () => {
    expect(diagnosticsUnsupportedMessage("darwin")).toContain("brew upgrade beads")
  })

  test.each(NOT_MAC)("platform %p never names brew", (platform) => {
    expect(diagnosticsUnsupportedMessage(platform)).not.toContain("brew")
  })
})

describe("bd error fixes use the host platform's hint", () => {
  test("unexpected-output carries bdUpgradeHint(process.platform)", () => {
    const loadError = toBdLoadError(new Error("Unexpected token 'b', \"bd 1.0\" is not valid JSON"))
    expect(loadError.category).toBe("unexpected-output")
    expect(loadError.fixCommand).toBe(bdUpgradeHint(process.platform).fixCommand)
    expect(loadError.fixDescription).toBe(bdUpgradeHint(process.platform).fixDescription)
  })
})
