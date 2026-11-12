import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const resolver = join(import.meta.dir, "../lib/bd-paths.ts")

describe("version-manager bd discovery", () => {
  test.each([
    ".local/share/mise/shims/bd",
    ".asdf/shims/bd",
    ".nix-profile/bin/bd",
    "custom mise/shims/bd",
    "custom asdf/shims/bd",
    "custom xdg/mise/shims/bd",
    ".local/state/nix/profiles/profile/bin/bd",
  ])("finds a synthetic %s without terminal PATH", async (relative) => {
    const home = await mkdtemp(join(tmpdir(), "beadbox-shim-"))
    try {
      const path = join(home, relative)
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, "#!/bin/sh\necho 'bd version 1.3.1'\n", { mode: 0o700 })
      const env = {
        ...process.env,
        HOME: home,
        BD_PATH: "",
        PATH: "/usr/bin:/bin",
        MISE_DATA_DIR: join(home, "custom mise"),
        ASDF_DATA_DIR: join(home, "custom asdf"),
        XDG_DATA_HOME: join(home, "custom xdg"),
        BEADBOX_SETTINGS_PATH: join(home, "settings.json"),
      }
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import {resolveBdPath,COMMON_BD_PATHS} from ${JSON.stringify(resolver)}; COMMON_BD_PATHS.splice(0,COMMON_BD_PATHS.length,...COMMON_BD_PATHS.filter(p=>p.startsWith(process.env.HOME+"/"))); console.log(resolveBdPath())`,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      )
      expect(await new Response(child.stdout).text()).toBe(`${path}\n`)
      expect(await child.exited).toBe(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

test("shims precede Homebrew and nix system profiles are candidates", async () => {
  const { COMMON_BD_PATHS } = await import("../lib/bd-paths")
  const { homedir } = await import("node:os")
  expect(COMMON_BD_PATHS.indexOf(join(homedir(), ".asdf/shims/bd"))).toBeLessThan(
    COMMON_BD_PATHS.indexOf("/opt/homebrew/bin/bd"),
  )
  expect(COMMON_BD_PATHS).toContain(`/etc/profiles/per-user/${process.env.USER}/bin/bd`)
  expect(COMMON_BD_PATHS).toContain("/nix/var/nix/profiles/default/bin/bd")
  expect(COMMON_BD_PATHS).toContain(
    `/nix/var/nix/profiles/per-user/${process.env.USER}/profile/bin/bd`,
  )
})

test("automatic detection skips a non-executable file and directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "beadbox-shim-mode-"))
  try {
    const blocked = join(home, "blocked")
    const directory = join(home, "directory")
    const good = join(home, "bd")
    await writeFile(blocked, "not executable", { mode: 0o600 })
    await mkdir(directory)
    await writeFile(good, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {resolveBdPath,COMMON_BD_PATHS} from ${JSON.stringify(resolver)}; COMMON_BD_PATHS.splice(0,COMMON_BD_PATHS.length,...${JSON.stringify([blocked, directory, good])}); console.log(resolveBdPath())`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          BD_PATH: "",
          BEADBOX_SETTINGS_PATH: join(home, "settings.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(await new Response(child.stdout).text()).toBe(`${good}\n`)
    expect(await child.exited).toBe(0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test.each([
  ".local/share/mise/shims",
  "custom mise/shims",
  ".asdf/shims",
  "custom asdf/shims",
  "custom xdg/mise/shims",
  ".nix-profile/bin",
  ".local/state/nix/profiles/profile/bin",
])("bd children find a dependency through %s on a minimal GUI PATH", async (relative) => {
  const home = await mkdtemp(join(tmpdir(), "beadbox-child-path-"))
  try {
    const dir = join(home, relative)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "fixture-dolt"), "#!/bin/sh\necho found-dependency\n", {
      mode: 0o700,
    })
    const bd = join(home, "bd")
    await writeFile(bd, "#!/bin/sh\nexec fixture-dolt\n", { mode: 0o700 })
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {execFileAsync} from ${JSON.stringify(join(import.meta.dir, "../lib/exec.ts"))}; console.log((await execFileAsync(${JSON.stringify(bd)}, [])).stdout.trim())`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: "/usr/bin:/bin",
          MISE_DATA_DIR: join(home, "custom mise"),
          ASDF_DATA_DIR: join(home, "custom asdf"),
          XDG_DATA_HOME: join(home, "custom xdg"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(await new Response(child.stdout).text()).toBe("found-dependency\n")
    expect(await child.exited).toBe(0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
