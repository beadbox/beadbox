import { afterEach, describe, expect, test } from "bun:test"
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

test("the sweep removes only our own real dirs, never a symlink, a foreign name, or a live dir", () => {
  root = mkdtempSync(join(tmpdir(), "beadbox-serve-unit-"))
  const uid = process.getuid?.() ?? -1
  const stale = join(root, `${SERVE_DIR_PREFIX}stale`)
  const live = join(root, `${SERVE_DIR_PREFIX}live`)
  const other = join(root, "not-ours")
  const target = join(root, "precious")
  const link = join(root, `${SERVE_DIR_PREFIX}link`)
  const file = join(root, `${SERVE_DIR_PREFIX}file`)
  for (const d of [stale, live, other, target]) mkdirSync(d)
  writeFileSync(join(target, "keep"), "x")
  symlinkSync(target, link)
  writeFileSync(file, "x")

  expect(sweepStaleServeDirs(root, new Set([live]), uid)).toEqual([stale])
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(target, "keep"), "utf-8")).toBe("x")
  for (const p of [live, other, file]) expect(() => lstatSync(p)).not.toThrow()

  // A dir owned by someone else (simulated by a uid that is not the owner).
  const foreign = join(root, `${SERVE_DIR_PREFIX}foreign`)
  mkdirSync(foreign)
  expect(sweepStaleServeDirs(root, new Set([live]), uid + 1)).toEqual([])
  expect(() => lstatSync(foreign)).not.toThrow()
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
