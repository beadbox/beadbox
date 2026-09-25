import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTokenDir,
  IDLE_STOP_MS,
  MAX_CHILDREN,
  parseListeningLine,
  SERVE_DIR_PREFIX,
  ServeManager,
  serveChildEnv,
  sweepStaleServeDirs,
} from "../lib/serve-manager"

const FAKE_BD = join(import.meta.dir, "fixtures", "fake-bd-serve.py")
const dirExists = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
let root: string
let manager: ServeManager | null = null
afterEach(async () => {
  await manager?.stopAll()
  manager = null
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("parseListeningLine (C1: exact loopback line only)", () => {
  test("accepts bd 1.3.0's line", () => {
    expect(parseListeningLine("bd serve: listening on http://127.0.0.1:59811")).toEqual({
      url: "http://127.0.0.1:59811",
      port: 59811,
    })
  })
  test("rejects anything else", () => {
    for (const line of [
      "bd serve: listening on http://0.0.0.0:59811",
      "bd serve: listening on http://localhost:59811",
      "bd serve: listening on http://127.0.0.1:59811 extra",
      " bd serve: listening on http://127.0.0.1:59811",
      "bd serve: listening on http://127.0.0.1:0",
      "bd serve: listening on http://127.0.0.1:99999",
      "bd serve: listening on http://127.0.0.2:59811",
      "Error: cannot resolve workspace context",
    ]) {
      expect(parseListeningLine(line)).toBeNull()
    }
  })
})

test("the child's env is a few base variables plus this workspace's Dolt settings only", () => {
  const env = serveChildEnv(
    { key: "a", workspaceDir: "/ws", env: { BEADS_DOLT_SERVER_PORT: "3307", BEADS_DOLT_PASSWORD: "pw", EVIL: "x" } },
    { PATH: "/bin", HOME: "/h", BEADBOX_CRED_OTHER: "secret", BEADS_DOLT_SERVER_PORT: "9999", AWS_SECRET: "s" },
  )
  expect(env).toEqual({ PATH: "/bin", HOME: "/h", BEADS_DOLT_SERVER_PORT: "3307", BEADS_DOLT_PASSWORD: "pw" })
})

test("C2: each token dir is fresh, 0700, with a 0600 token", () => {
  root = mkdtempSync(join(tmpdir(), "beadbox-serve-unit-"))
  const a = createTokenDir(root)
  const b = createTokenDir(root)
  expect(a.dir).not.toBe(b.dir)
  expect(a.token).not.toBe(b.token)
  expect(Buffer.from(a.token, "base64url").length).toBe(32)
  expect(statSync(a.dir).mode & 0o777).toBe(0o700)
  expect(statSync(join(a.dir, "token")).mode & 0o777).toBe(0o600)
  expect(readFileSync(join(a.dir, "token"), "utf-8")).toBe(`${a.token}\n`)
})

/** A pid that just exited (so no process has it). */
function deadPid(): number {
  const r = spawnSync("/usr/bin/true")
  if (!r.pid) throw new Error("could not spawn /usr/bin/true")
  return r.pid
}

test("the sweep removes only stale dirs of dead sidecars: never a live pid's, a symlink, a foreign name or uid, or a live dir", () => {
  root = mkdtempSync(join(tmpdir(), "beadbox-serve-unit-"))
  const uid = process.getuid?.() ?? -1
  const dead = deadPid()
  const d = (tag: string, pid: number | string = dead) => join(root, `${SERVE_DIR_PREFIX}${pid}-${tag}`)
  const stale = d("stale")
  const live = d("live")
  const otherInstance = d("other", process.pid) // a running sidecar's dir
  const unattributed = join(root, `${SERVE_DIR_PREFIX}nopid`)
  const other = join(root, "not-ours")
  const target = join(root, "precious")
  const link = d("link")
  const file = d("file")
  for (const p of [stale, live, otherInstance, unattributed, other, target]) mkdirSync(p)
  writeFileSync(join(target, "keep"), "x")
  symlinkSync(target, link)
  writeFileSync(file, "x")

  expect(sweepStaleServeDirs(root, new Set([live]), uid)).toEqual([stale])
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(target, "keep"), "utf-8")).toBe("x")
  for (const p of [live, otherInstance, unattributed, other, file]) expect(() => lstatSync(p)).not.toThrow()

  const foreign = d("foreign")
  mkdirSync(foreign)
  expect(sweepStaleServeDirs(root, new Set([live]), uid + 1)).toEqual([])
  expect(() => lstatSync(foreign)).not.toThrow()
})

test("token dirs are named with the creating sidecar's pid", () => {
  root = mkdtempSync(join(tmpdir(), "beadbox-serve-unit-"))
  const { dir } = createTokenDir(root)
  expect(dir.split("/").pop()?.startsWith(`${SERVE_DIR_PREFIX}${process.pid}-`)).toBe(true)
})

describe("ServeManager supervision (real children via the fake bd)", () => {
  const target = (key: string, extra: Record<string, string> = {}) => ({ key, workspaceDir: root, env: extra })

  test("reuses a live child, caps children with LRU eviction, and stops idle ones on access", async () => {
    root = mkdtempSync(join(tmpdir(), "beadbox-serve-unit-"))
    let clock = 1_000_000
    manager = new ServeManager({ bdPath: () => FAKE_BD, now: () => clock, tokenRoot: root })
    const first = await manager.get(target("a"))
    expect((await manager.get(target("a"))).pid).toBe(first.pid)

    for (let i = 1; i < MAX_CHILDREN; i++) {
      clock += 1000
      await manager.get(target(`k${i}`))
    }
    expect(manager.liveTokenDirs().size).toBe(MAX_CHILDREN)
    clock += 1000
    await manager.get(target("newest")) // evicts "a", the least recently used
    expect(manager.liveTokenDirs().size).toBe(MAX_CHILDREN)
    expect((await manager.get(target("a"))).pid).not.toBe(first.pid)

    clock += IDLE_STOP_MS + 1
    await manager.get(target("fresh"))
    await Bun.sleep(300)
    expect(manager.liveTokenDirs().size).toBe(1)
  }, 30_000)

  test("a token dir never outlives its child, even when the wrapper is SIGKILLed before its cleanup (sec)", async () => {
    root = mkdtempSync(join(tmpdir(), "beadbox-serve-unit-"))
    manager = new ServeManager({ bdPath: () => FAKE_BD, tokenRoot: root })
    const h = await manager.get(target("k"))
    const [dir] = [...manager.liveTokenDirs()]
    expect(statSync(dir).isDirectory()).toBe(true) // precondition
    process.kill(-h.pid, "SIGKILL") // the whole group, wrapper included: its own cleanup never runs
    const end = Date.now() + 3000
    while (Date.now() < end && dirExists(dir)) await Bun.sleep(50)
    expect(dirExists(dir)).toBe(false)
    expect(manager.liveTokenDirs().size).toBe(0)
    await manager.stop("k") // a no-op now, and harmless
  }, 30_000)

  test("a wrong listening line is a startup failure: rejected, cleaned up, then backed off", async () => {
    root = mkdtempSync(join(tmpdir(), "beadbox-serve-unit-"))
    const clock = 5_000_000
    manager = new ServeManager({ bdPath: () => FAKE_BD, now: () => clock, tokenRoot: root })
    const bad = target("bad", { BEADS_DOLT_FAKE_SERVE_LINE: "wrong" })
    await expect(manager.get(bad)).rejects.toThrow("unexpected first stdout line")
    await Bun.sleep(300)
    expect(sweepStaleServeDirs(root, new Set(), -2)).toEqual([]) // nothing to find: no dirs left
    await expect(manager.get(bad)).rejects.toThrow("restart backoff")
  }, 30_000)
})
