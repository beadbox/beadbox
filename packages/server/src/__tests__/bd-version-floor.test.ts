// The startup gate's bd version floor (beadbox-piv: bd 1.0.x dropped, floor 1.1.0).
//
// checkHealth runs a real `bd --version` probe, so each case stands a shell
// script in for a specific bd release and drives the actual gate path —
// probe, parse, compare — rather than calling the comparison in isolation.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBdPathCache } from "../lib/bd-paths"
import { getVersionStatus, MIN_BD_VERSION } from "../lib/version-requirements"
import { checkHealth } from "../lib/workspace-health"
import type { RegistryEntry } from "../lib/workspace-registry"

const originalBdPath = process.env.BD_PATH
let root: string | undefined

afterEach(async () => {
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  __resetBdPathCache()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A local workspace whose bd reports `versionLine` and answers `bd list` with []. */
async function workspaceWithBd(versionLine: string): Promise<RegistryEntry> {
  root = await mkdtemp(join(tmpdir(), "beadbox-bd-floor-"))
  await mkdir(join(root, ".beads"))
  // local.path is root, so root is the workspace dir the presence check reads
  // (beadbox-fdk): give it a genuine marker.
  await writeFile(join(root, "metadata.json"), "{}")
  const bdPath = join(root, "bd")
  await writeFile(
    bdPath,
    `#!/bin/sh\ncase "$1" in\n  --version) echo "${versionLine}" ;;\n  *) echo '[]' ;;\nesac\n`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = bdPath
  __resetBdPathCache()
  return {
    id: "3f1b8a24-0000-4000-8000-0000000f1000",
    name: "floor",
    addedAt: "2026-09-25T00:00:00.000Z",
    local: { path: root },
    server: null,
    mode: "embedded",
  }
}

test("the floor is bd 1.1.0", () => {
  expect(MIN_BD_VERSION).toBe("1.1.0")
})

describe("startup gate refuses bd below the floor", () => {
  test.each([
    ["bd version 1.0.4 (Homebrew)", "1.0.4"],
    ["bd version 1.0.1 (dev)", "1.0.1"],
    ["bd version 1.0.99", "1.0.99"],
  ])("%s is refused and told the required version", async (versionLine, current) => {
    const result = await checkHealth(await workspaceWithBd(versionLine))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: "bd_version_too_old", current, required: "1.1.0" })
  })
})

describe("startup gate admits bd at or above the floor", () => {
  test.each([
    "bd version 1.1.0 (Homebrew)",
    "bd version 1.2.2 (Homebrew)",
  ])("%s passes", async (versionLine) => {
    const result = await checkHealth(await workspaceWithBd(versionLine))
    expect(result).toMatchObject({ ok: true })
  })
})

describe("upgrade command is platform-gated", () => {
  test("brew on macOS only", () => {
    expect(getVersionStatus("bd", "1.0.4", "darwin").upgradeCommand).toBe("brew upgrade beads")
    for (const platform of ["linux", "win32", "freebsd", ""]) {
      expect(getVersionStatus("bd", "1.0.4", platform).upgradeCommand).not.toContain("brew")
    }
  })

  test("Linux gets go install of bd's real module path", () => {
    // Module path: `go version -m $(which bd)` → github.com/steveyegge/beads/cmd/bd.
    // Env + tag: beads' documented embedded-capable install (plain go install is not one).
    expect(getVersionStatus("bd", "1.0.4", "linux").upgradeCommand).toBe(
      "CGO_ENABLED=1 GOFLAGS=-tags=gms_pure_go go install github.com/steveyegge/beads/cmd/bd@latest",
    )
  })

  test("bd at the floor needs no upgrade", () => {
    expect(getVersionStatus("bd", "1.1.0", "darwin")).toMatchObject({ status: "ok" })
    expect(getVersionStatus("bd", "1.0.4", "darwin")).toMatchObject({
      status: "error",
      message: "Requires v1.1.0+",
    })
  })
})
