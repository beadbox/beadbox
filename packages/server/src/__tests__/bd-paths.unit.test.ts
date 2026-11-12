import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  type BdResolveOptions,
  getCandidateBdPaths,
  resetPathCaches,
  resolveBdPath,
  resolveBdPathWithOptions,
} from "../lib/bd-paths"

const resolveWith = (opts: BdResolveOptions): string => resolveBdPathWithOptions(opts)

let sandbox: string
let homeDir: string
let sysRoot: string

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "beadbox-bd-paths-"))
  homeDir = join(sandbox, "home")
  sysRoot = join(sandbox, "sys")
  await mkdir(homeDir, { recursive: true })
  await mkdir(sysRoot, { recursive: true })
  resetPathCaches()
})

afterEach(async () => {
  resetPathCaches()
  if (sandbox) {
    await rm(sandbox, { recursive: true, force: true })
  }
})

async function createFakeBd(filePath: string, mode = 0o755): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, "#!/bin/sh\necho 'bd version 1.3.4'\n")
  await chmod(filePath, mode)
  return filePath
}

describe("resolveBdPath — version manager shim/profile auto-detection", () => {
  test("finds bd in default mise shims (~/.local/share/mise/shims/bd)", async () => {
    const shim = await createFakeBd(join(homeDir, ".local", "share", "mise", "shims", "bd"))
    expect(resolveWith({ env: {}, home: homeDir, platform: "darwin", systemRoot: sysRoot })).toBe(
      shim,
    )
  })

  test("finds bd in $MISE_DATA_DIR/shims/bd and prefers it over default mise shims", async () => {
    const customMiseDir = join(sandbox, "custom-mise")
    const envShim = await createFakeBd(join(customMiseDir, "shims", "bd"))
    await createFakeBd(join(homeDir, ".local", "share", "mise", "shims", "bd"))

    expect(
      resolveWith({
        env: { MISE_DATA_DIR: customMiseDir },
        home: homeDir,
        platform: "darwin",
        systemRoot: sysRoot,
      }),
    ).toBe(envShim)
  })

  test("expands leading ~/ in $MISE_DATA_DIR", async () => {
    const envShim = await createFakeBd(join(homeDir, "my-mise", "shims", "bd"))
    expect(
      resolveWith({
        env: { MISE_DATA_DIR: "~/my-mise" },
        home: homeDir,
        platform: "linux",
        systemRoot: sysRoot,
      }),
    ).toBe(envShim)
  })

  test("finds bd in $XDG_DATA_HOME/mise/shims/bd", async () => {
    const xdgData = join(sandbox, "xdg-data")
    const xdgShim = await createFakeBd(join(xdgData, "mise", "shims", "bd"))
    await createFakeBd(join(homeDir, ".local", "share", "mise", "shims", "bd"))

    expect(
      resolveWith({
        env: { XDG_DATA_HOME: xdgData },
        home: homeDir,
        platform: "linux",
        systemRoot: sysRoot,
      }),
    ).toBe(xdgShim)
  })

  test("finds bd in default asdf shims (~/.asdf/shims/bd) and $ASDF_DATA_DIR/shims/bd", async () => {
    const defaultAsdf = await createFakeBd(join(homeDir, ".asdf", "shims", "bd"))
    expect(resolveWith({ env: {}, home: homeDir, platform: "darwin", systemRoot: sysRoot })).toBe(
      defaultAsdf,
    )

    const customAsdfDir = join(sandbox, "custom-asdf")
    const customAsdf = await createFakeBd(join(customAsdfDir, "shims", "bd"))
    expect(
      resolveWith({
        env: { ASDF_DATA_DIR: customAsdfDir },
        home: homeDir,
        platform: "darwin",
        systemRoot: sysRoot,
      }),
    ).toBe(customAsdf)
  })

  test("finds bd in ~/.nix-profile/bin/bd (including symlink into nix store)", async () => {
    const storeBin = await createFakeBd(
      join(sysRoot, "nix", "store", "abc123-beads-1.3.4", "bin", "bd"),
    )
    const nixProfileBin = join(homeDir, ".nix-profile", "bin", "bd")
    await mkdir(dirname(nixProfileBin), { recursive: true })
    await symlink(storeBin, nixProfileBin)

    expect(resolveWith({ env: {}, home: homeDir, platform: "darwin", systemRoot: sysRoot })).toBe(
      nixProfileBin,
    )
  })

  test("finds bd in ~/.local/state/nix/profile/bin/bd and $XDG_STATE_HOME/nix/profile/bin/bd", async () => {
    const stateNix = await createFakeBd(
      join(homeDir, ".local", "state", "nix", "profile", "bin", "bd"),
    )
    expect(resolveWith({ env: {}, home: homeDir, platform: "linux", systemRoot: sysRoot })).toBe(
      stateNix,
    )

    const xdgState = join(sandbox, "xdg-state")
    const xdgStateNix = await createFakeBd(join(xdgState, "nix", "profile", "bin", "bd"))
    expect(
      resolveWith({
        env: { XDG_STATE_HOME: xdgState },
        home: homeDir,
        platform: "linux",
        systemRoot: sysRoot,
      }),
    ).toBe(xdgStateNix)
  })

  test("finds bd in /etc/profiles/per-user/$USER/bin/bd and /nix/var/nix/profiles/default/bin/bd", async () => {
    const defaultNix = await createFakeBd(
      join(sysRoot, "nix", "var", "nix", "profiles", "default", "bin", "bd"),
    )
    expect(resolveWith({ env: {}, home: homeDir, platform: "darwin", systemRoot: sysRoot })).toBe(
      defaultNix,
    )

    const perUserNix = await createFakeBd(
      join(sysRoot, "etc", "profiles", "per-user", "alice", "bin", "bd"),
    )
    expect(
      resolveWith({
        env: { USER: "alice" },
        home: homeDir,
        platform: "darwin",
        systemRoot: sysRoot,
      }),
    ).toBe(perUserNix)
  })

  test("skips directories, non-executable files, and dangling symlinks at candidate paths", async () => {
    // Directory at mise shim path
    await mkdir(join(homeDir, ".local", "share", "mise", "shims", "bd"), { recursive: true })
    // Non-executable file at asdf shim path
    await createFakeBd(join(homeDir, ".asdf", "shims", "bd"), 0o644)
    // Dangling symlink at ~/.nix-profile/bin/bd
    const nixLink = join(homeDir, ".nix-profile", "bin", "bd")
    await mkdir(dirname(nixLink), { recursive: true })
    await symlink(join(sandbox, "missing-store-target"), nixLink)

    // Valid executable at ~/go/bin/bd should win after invalid candidates are skipped
    const goBd = await createFakeBd(join(homeDir, "go", "bin", "bd"))
    expect(resolveWith({ env: {}, home: homeDir, platform: "darwin", systemRoot: sysRoot })).toBe(
      goBd,
    )
  })

  test("falls back to bare 'bd' when no candidate path exists", () => {
    expect(resolveWith({ env: {}, home: homeDir, platform: "darwin", systemRoot: sysRoot })).toBe(
      "bd",
    )
  })

  test("BD_PATH env override wins over auto-detected shim paths", async () => {
    await createFakeBd(join(homeDir, ".local", "share", "mise", "shims", "bd"))
    const envBd = await createFakeBd(join(sandbox, "override", "bd"))
    expect(
      resolveWith({
        env: { BD_PATH: envBd },
        home: homeDir,
        platform: "darwin",
        systemRoot: sysRoot,
      }),
    ).toBe(envBd)
  })

  test("ignores relative or NUL-containing env dir overrides", async () => {
    await createFakeBd(join(sandbox, "rel-mise", "shims", "bd"))
    expect(
      resolveWith({
        env: {
          MISE_DATA_DIR: "rel-mise",
          ASDF_DATA_DIR: `/tmp/bad\0asdf`,
          USER: "../etc",
        },
        home: homeDir,
        platform: "linux",
        systemRoot: sysRoot,
      }),
    ).toBe("bd")
  })

  test("exposes dynamic candidate list including $MISE_DATA_DIR/shims for diagnostics", () => {
    const list = getCandidateBdPaths({
      env: { MISE_DATA_DIR: "/custom/mise", ASDF_DATA_DIR: "/custom/asdf", USER: "bob" },
      home: "/Users/bob",
      platform: "darwin",
    })
    expect(list).toContain("/custom/mise/shims/bd")
    expect(list).toContain("/Users/bob/.local/share/mise/shims/bd")
    expect(list).toContain("/custom/asdf/shims/bd")
    expect(list).toContain("/Users/bob/.asdf/shims/bd")
    expect(list).toContain("/Users/bob/.nix-profile/bin/bd")
    expect(list).toContain("/etc/profiles/per-user/bob/bin/bd")
    expect(list).toContain("/nix/var/nix/profiles/default/bin/bd")
  })

  test("resolveBdPath caches result and resetPathCaches invalidates cache", async () => {
    const origBdPath = process.env.BD_PATH
    try {
      const first = await createFakeBd(join(sandbox, "first", "bd"))
      const second = await createFakeBd(join(sandbox, "second", "bd"))
      process.env.BD_PATH = first
      resetPathCaches()
      expect(resolveBdPath()).toBe(first)

      process.env.BD_PATH = second
      expect(resolveBdPath()).toBe(first)

      resetPathCaches()
      expect(resolveBdPath()).toBe(second)
    } finally {
      if (origBdPath === undefined) delete process.env.BD_PATH
      else process.env.BD_PATH = origBdPath
      resetPathCaches()
    }
  })
})
