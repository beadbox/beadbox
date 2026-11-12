import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const resolver = join(import.meta.dir, "../lib/bd-paths.ts")

describe("version-manager bd discovery", () => {
  test.each([".local/share/mise/shims/bd", ".asdf/shims/bd", ".nix-profile/bin/bd", "custom mise/shims/bd"])("finds a synthetic %s without terminal PATH", async (relative) => {
    const home = await mkdtemp(join(tmpdir(), "beadbox-shim-"))
    try {
      const path = join(home, relative)
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, "#!/bin/sh\necho 'bd version 1.3.1'\n", { mode: 0o700 })
      const env = { ...process.env, HOME: home, BD_PATH: "", PATH: "/usr/bin:/bin", MISE_DATA_DIR: join(home, "custom mise") }
      const child = Bun.spawn([process.execPath, "-e", `import {resolveBdPath,COMMON_BD_PATHS} from ${JSON.stringify(resolver)}; COMMON_BD_PATHS.splice(0,COMMON_BD_PATHS.length,...COMMON_BD_PATHS.filter(p=>p.startsWith(process.env.HOME+"/"))); console.log(resolveBdPath())`], { env, stdout: "pipe", stderr: "pipe" })
      expect(await new Response(child.stdout).text()).toBe(`${path}\n`)
      expect(await child.exited).toBe(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
