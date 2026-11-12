import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as paths from "../lib/bd-paths"

let root: string
const saved = { bd: process.env.BD_PATH, config: process.env.BEADBOX_SETTINGS_PATH }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-bd-preference-"))
  process.env.BEADBOX_SETTINGS_PATH = join(root, "settings.json")
  delete process.env.BD_PATH
  paths.resetPathCaches()
})
afterEach(async () => {
  if (saved.bd === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = saved.bd
  if (saved.config === undefined) delete process.env.BEADBOX_SETTINGS_PATH
  else process.env.BEADBOX_SETTINGS_PATH = saved.config
  paths.resetPathCaches()
  await rm(root, { recursive: true, force: true })
})
async function binary(name = "bd with spaces", output = "bd version 1.3.1") {
  const path = join(root, name)
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o700 })
  return path
}

test("saved per-user path survives a fresh process and BD_PATH wins", async () => {
  const path = await binary()
  await writeFile(process.env.BEADBOX_SETTINGS_PATH!, JSON.stringify({ bdPath: path }))
  expect(paths.resolveBdPath()).toBe(path)
  expect(paths.getBdPathSelection()).toMatchObject({
    source: "saved",
    resolvedPath: path,
    savedPath: path,
  })
  process.env.BD_PATH = "/env/bd"
  expect(paths.resolveBdPath()).toBe("/env/bd")
  expect(paths.getBdPathSelection().source).toBe("environment")
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {resolveBdPath} from ${JSON.stringify(join(import.meta.dir, "../lib/bd-paths.ts"))};console.log(resolveBdPath())`,
    ],
    { env: { ...process.env, BD_PATH: "" }, stdout: "pipe" },
  )
  expect(await new Response(child.stdout).text()).toBe(`${path}\n`)
  expect(await child.exited).toBe(0)
})
test("validates an executable with spaces without a shell", async () => {
  const path = await binary("bd $(touch sentinel)")
  expect(await paths.validateBdPath(path)).toBe("1.3.1")
})
test.each(["relative/bd", "", "/tmp/bd\0evil"])("rejects malformed path %j", async (path) => {
  await expect(paths.validateBdPath(path)).rejects.toThrow("absolute")
})
test("rejects missing, directory and non-executable paths", async () => {
  await expect(paths.validateBdPath(join(root, "missing"))).rejects.toThrow("executable")
  await mkdir(join(root, "directory"))
  await expect(paths.validateBdPath(join(root, "directory"))).rejects.toThrow("regular")
  const path = await binary()
  await chmod(path, 0o600)
  await expect(paths.validateBdPath(path)).rejects.toThrow("executable")
})
test("rejects old and unparseable versions", async () => {
  await expect(paths.validateBdPath(await binary("old", "bd version 1.0.4"))).rejects.toThrow(
    "1.1.0",
  )
  await expect(paths.validateBdPath(await binary("unknown", "not a version"))).rejects.toThrow(
    "version",
  )
})
test("bounds the version probe", async () => {
  const path = join(root, "hang")
  await writeFile(path, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 })
  const start = Date.now()
  await expect(paths.validateBdPath(path)).rejects.toThrow("version")
  expect(Date.now() - start).toBeLessThan(8000)
}, 10000)

test("save validates first; reset returns to automatic detection and preserves other preferences", async () => {
  const { setBdPath, getBdPath } = await import("../handlers/bd-settings")
  await writeFile(process.env.BEADBOX_SETTINGS_PATH!, JSON.stringify({ other: true }))
  const path = await binary()
  expect((await setBdPath(path)).source).toBe("saved")
  await expect(setBdPath(join(root, "missing"))).rejects.toThrow()
  expect((await getBdPath()).savedPath).toBe(path)
  expect((await setBdPath(null)).source).toBe("automatic")
  expect(JSON.parse(await readFile(process.env.BEADBOX_SETTINGS_PATH!, "utf8"))).toEqual({
    other: true,
  })
})

test("a saved executable that disappears stays selected until reset", async () => {
  const { setBdPath } = await import("../handlers/bd-settings")
  const { checkBdHealth } = await import("../handlers/health")
  const path = await binary()
  await setBdPath(path)
  await rm(path)
  expect(paths.resolveBdPath()).toBe(path)
  expect(await checkBdHealth()).toMatchObject({ bdAvailable: false })
  expect(paths.getBdPathSelection().source).toBe("saved")
  expect((await setBdPath(null)).source).toBe("automatic")
})

test("saving and resetting a preference never supersedes BD_PATH", async () => {
  const { setBdPath } = await import("../handlers/bd-settings")
  process.env.BD_PATH = "/env/bd"
  const path = await binary()
  expect(await setBdPath(path)).toEqual({
    resolvedPath: "/env/bd",
    source: "environment",
    savedPath: path,
  })
  expect(await setBdPath(null)).toEqual({
    resolvedPath: "/env/bd",
    source: "environment",
    savedPath: null,
  })
})

test("automatic candidates retain order and Retry clears the cached choice", async () => {
  const original = [...paths.COMMON_BD_PATHS]
  const first = await binary("first")
  const second = await binary("second")
  paths.COMMON_BD_PATHS.splice(0, paths.COMMON_BD_PATHS.length, first, second)
  try {
    expect(paths.resolveBdPath()).toBe(first)
    await rm(first)
    expect(paths.resolveBdPath()).toBe(first)
    paths.resetPathCaches()
    expect(paths.resolveBdPath()).toBe(second)
    await writeFile(process.env.BEADBOX_SETTINGS_PATH!, JSON.stringify({ bdPath: "/saved/bd" }))
    expect(paths.resolveBdPath()).toBe("/saved/bd")
  } finally {
    paths.COMMON_BD_PATHS.splice(0, paths.COMMON_BD_PATHS.length, ...original)
  }
})
