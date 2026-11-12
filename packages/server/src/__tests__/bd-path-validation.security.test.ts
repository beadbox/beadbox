import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { resetPathCaches, resolveBdPathWithOptions } from "../lib/bd-paths"
import * as bdSettingsModule from "../lib/bd-settings"

interface ValidationFailure {
  ok: false
  code: string
  error: string
}
interface ValidationSuccess {
  ok: true
  normalizedPath: string
  version: string
}
type ValidationResult = ValidationSuccess | ValidationFailure

const validateBdBinary = (
  raw: string,
  opts?: { home?: string; platform?: NodeJS.Platform; probeTimeoutMs?: number },
): Promise<ValidationResult> =>
  (
    bdSettingsModule as unknown as {
      validateBdBinary: (
        r: string,
        o?: { home?: string; platform?: NodeJS.Platform; probeTimeoutMs?: number },
      ) => Promise<ValidationResult>
    }
  ).validateBdBinary(raw, opts)

let sandbox: string

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "beadbox-bd-sec-"))
  resetPathCaches()
})

afterEach(async () => {
  resetPathCaches()
  if (sandbox) {
    await rm(sandbox, { recursive: true, force: true })
  }
})

describe("validateBdBinary security invariants", () => {
  test("rejects empty, non-string, relative, and NUL-byte paths before syscalls", async () => {
    for (const bad of [
      "",
      "   ",
      "bd",
      "./bd",
      "../bin/bd",
      "relative/path/to/bd",
      "/tmp/bd\0/evil",
      "~/bin/bd\0evil",
    ]) {
      const res = await validateBdBinary(bad, { home: join(sandbox, "home") })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe("invalid_path")
      }
    }

    const nonString = await validateBdBinary(null as unknown as string)
    expect(nonString).toMatchObject({ ok: false, code: "invalid_path" })
  })

  test("expands leading ~/ and rejects non-bd executables (e.g. git --version output)", async () => {
    const fakeGit = join(sandbox, "home", "bin", "not-bd")
    await mkdir(dirname(fakeGit), { recursive: true })
    await writeFile(fakeGit, '#!/bin/sh\necho "git version 2.43.0"\n')
    await chmod(fakeGit, 0o755)

    const res = await validateBdBinary("~/bin/not-bd", { home: join(sandbox, "home") })
    expect(res).toMatchObject({ ok: false, code: "probe_failed" })
  })

  test("enforces --version probe timeout on hanging executables", async () => {
    const hanging = join(sandbox, "hanging-bd")
    await writeFile(hanging, "#!/bin/sh\nsleep 5\n")
    await chmod(hanging, 0o755)

    const t0 = Date.now()
    const res = await validateBdBinary(hanging, { probeTimeoutMs: 150 })
    const elapsed = Date.now() - t0
    expect(res).toMatchObject({ ok: false, code: "probe_timeout" })
    expect(elapsed).toBeLessThan(2500)
  })

  test("never invokes a shell when probing paths containing shell metacharacters and spaces", async () => {
    const pwnedFile = join(sandbox, "pwned-marker")
    const trickyDir = join(sandbox, `dir $(touch "${pwnedFile}"); echo hi`)
    const trickyBd = join(trickyDir, "bd")
    await mkdir(trickyDir, { recursive: true })
    await writeFile(trickyBd, '#!/bin/sh\necho "bd version 1.3.4"\n')
    await chmod(trickyBd, 0o755)

    const res = await validateBdBinary(trickyBd)
    expect(res).toEqual({
      ok: true,
      normalizedPath: trickyBd,
      version: "1.3.4",
    })

    let markerExists = true
    try {
      await stat(pwnedFile)
    } catch {
      markerExists = false
    }
    expect(markerExists).toBe(false)
  })

  test("ignores hand-edited corrupt settings.json containing relative or NUL paths", async () => {
    const settingsPath = join(sandbox, "settings.json")
    const sysRoot = join(sandbox, "sys")
    const homeDir = join(sandbox, "home")
    await mkdir(sysRoot, { recursive: true })
    await mkdir(homeDir, { recursive: true })

    for (const corrupt of ["relative/bd", "/tmp/bad\0bd", ""]) {
      await writeFile(settingsPath, JSON.stringify({ version: 1, bdPath: corrupt }))
      expect(
        resolveBdPathWithOptions({
          env: {},
          home: homeDir,
          platform: "darwin",
          systemRoot: sysRoot,
          settingsPath,
        }),
      ).toBe("bd")
    }
  })
})
