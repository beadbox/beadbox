// beadbox-lvlz: the e2e harness's shared browser. A local run never downloads
// one: the check fails fast with the install command, and the install lock
// cannot be wedged by a dead holder. Every directory is a fresh scratch dir;
// every process signalled here is one this file spawned.

import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkBrowser,
  holderAlive,
  lockedPlaywrightVersion,
  type Pins,
  readOwner,
  readPins,
  sharedBrowsersDir,
  tryAcquire,
} from "../../../../scripts/e2e-browser"

const REPO = join(import.meta.dir, "..", "..", "..", "..")
const SCRIPT = join(REPO, "scripts", "e2e-browser.ts")

const dirs: string[] = []
const spawned: number[] = []
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "beadbox-lvlz-"))
  dirs.push(d)
  return d
}

const PINS: Pins = { lockVersion: "1.59.1", installedVersion: "1.59.1", shellRevision: "1217" }

const installMarker = (dir: string, revision: string) => {
  mkdirSync(join(dir, `chromium_headless_shell-${revision}`), { recursive: true })
  writeFileSync(join(dir, `chromium_headless_shell-${revision}`, "INSTALLATION_COMPLETE"), "")
}

// A live process whose command line marks it as one of this tool's.
const spawnHolder = () => {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60000)", "e2e-browser-test-holder"],
    {
      stdio: "ignore",
    },
  )
  if (child.pid) spawned.push(child.pid)
  return child
}

const runCli = (args: string[], env: Record<string, string>) => {
  const started = Date.now()
  const r = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: REPO,
    env: { ...process.env, CI: "", E2E_CHROMIUM: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
    ms: Date.now() - started,
  }
}

describe("shared e2e browser (beadbox-lvlz)", () => {
  test("the shared dir is one per machine, outside the clone", () => {
    expect(sharedBrowsersDir({}, "darwin")).toEndWith("/Library/Caches/beadbox-e2e-browsers")
    expect(sharedBrowsersDir({ XDG_CACHE_HOME: "/x" }, "linux")).toBe("/x/beadbox-e2e-browsers")
    expect(sharedBrowsersDir({ BEADBOX_E2E_BROWSERS: "/s" }, "darwin")).toBe("/s")
  })

  test("pins come from bun.lock and the installed playwright-core", () => {
    const pins = readPins(REPO)
    expect(pins.lockVersion).toBe(pins.installedVersion)
    expect(pins.shellRevision).toMatch(/^\d+$/)
    expect(lockedPlaywrightVersion('"@playwright/test": ["@playwright/test@1.60.0", "",')).toBe(
      "1.60.0",
    )
  })

  test("browser present: check passes", () => {
    const dir = scratch()
    installMarker(dir, "1217")
    expect(checkBrowser(PINS, dir)).toEqual({ ok: true })
  })

  test("a partial install (no INSTALLATION_COMPLETE) is not installed", () => {
    const dir = scratch()
    mkdirSync(join(dir, "chromium_headless_shell-1217"))
    const r = checkBrowser(PINS, dir)
    expect(r.ok).toBe(false)
  })

  test("a version bump names the missing revision and the install command", () => {
    const dir = scratch()
    installMarker(dir, "1217")
    const r = checkBrowser(
      { ...PINS, lockVersion: "1.60.0", installedVersion: "1.60.0", shellRevision: "1230" },
      dir,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain("r1230")
      expect(r.message).toContain("bun run e2e:browser:install")
    }
  })

  test("bun.lock bumped but node_modules not reinstalled says bun install", () => {
    const r = checkBrowser({ ...PINS, lockVersion: "1.60.0" }, scratch())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("Run: bun install")
  })

  test("browser absent: the CLI check fails fast with one line, and creates nothing", () => {
    const dir = join(scratch(), "browsers")
    const r = runCli(["check"], { BEADBOX_E2E_BROWSERS: dir })
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(5_000)
    expect(r.out.trim().split("\n")).toHaveLength(1)
    expect(r.out).toContain("bun run e2e:browser:install")
    expect(() => readdirSync(dir)).toThrow()
  })

  test("browser absent: run never reaches playwright", () => {
    const dir = join(scratch(), "browsers")
    const r = runCli(["run", "--list"], { BEADBOX_E2E_BROWSERS: dir })
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(5_000)
    expect(r.out).toContain("bun run e2e:browser:install")
    expect(r.out).not.toContain("Listing tests")
  })

  test("install when already installed exits 0 without taking the lock", () => {
    const dir = scratch()
    const pins = readPins(REPO)
    installMarker(dir, pins.shellRevision)
    const r = runCli(["install"], { BEADBOX_E2E_BROWSERS: dir })
    expect(r.code).toBe(0)
    expect(r.out).toContain("already installed")
    expect(readdirSync(dir)).not.toContain(".install.lock")
  })
})

describe("install lock (beadbox-lvlz)", () => {
  test("free lock: taken, owned by this pid", () => {
    const dir = scratch()
    expect(tryAcquire(dir)).toEqual({ taken: true })
    expect(readOwner(dir)?.pid).toBe(process.pid)
  })

  test("a live holder keeps the lock", () => {
    const dir = scratch()
    const holder = spawnHolder()
    mkdirSync(join(dir, ".install.lock"))
    writeFileSync(
      join(dir, ".install.lock", "owner.json"),
      JSON.stringify({ pid: holder.pid, startedAt: Date.now() }),
    )
    const got = tryAcquire(dir)
    expect(got.taken).toBe(false)
    if (!got.taken) expect(got.owner?.pid).toBe(holder.pid as number)
  })

  test("a dead holder's lock is stale and re-taken", async () => {
    const dir = scratch()
    const holder = spawnHolder()
    const pid = holder.pid as number
    const exited = new Promise((r) => holder.on("exit", r))
    process.kill(pid, "SIGKILL")
    await exited
    mkdirSync(join(dir, ".install.lock"))
    writeFileSync(
      join(dir, ".install.lock", "owner.json"),
      JSON.stringify({ pid, startedAt: Date.now() - 1000 }),
    )
    const got = tryAcquire(dir)
    expect(got.taken).toBe(true)
    if (got.taken) expect(got.stale).toContain(`pid ${pid}`)
    expect(readOwner(dir)?.pid).toBe(process.pid)
  })

  test("a live pid that is not ours (recycled) does not hold the lock", () => {
    // sleep's command line does not mark it as this tool's.
    const other = spawn("sleep", ["60"], { stdio: "ignore" })
    if (other.pid) spawned.push(other.pid)
    expect(holderAlive({ pid: other.pid as number, startedAt: Date.now() })).toBe(false)
  })

  test("wrapper dead but its playwright child alive: still held", () => {
    // The child's command line names playwright, as the real install child's does.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)", "playwright-install-test"],
      {
        stdio: "ignore",
      },
    )
    if (child.pid) spawned.push(child.pid)
    expect(
      holderAlive({ pid: 999_999, childPid: child.pid as number, startedAt: Date.now() }),
    ).toBe(true)
  })

  test("an ownerless lock is held while fresh, stale once old", () => {
    const dir = scratch()
    mkdirSync(join(dir, ".install.lock"))
    expect(tryAcquire(dir).taken).toBe(false)
    const old = (Date.now() - 120_000) / 1000
    utimesSync(join(dir, ".install.lock"), old, old)
    const got = tryAcquire(dir)
    expect(got.taken).toBe(true)
    if (got.taken) expect(got.stale).toContain("no owner")
  })

  test("a waiter behind a stuck holder exits 1 naming it, and never signals it", () => {
    const dir = scratch()
    const holder = spawnHolder()
    mkdirSync(join(dir, ".install.lock"))
    writeFileSync(
      join(dir, ".install.lock", "owner.json"),
      JSON.stringify({ pid: holder.pid, startedAt: Date.now() - 10 * 60_000 }),
    )
    const r = runCli(["install"], {
      BEADBOX_E2E_BROWSERS: dir,
      BEADBOX_E2E_INSTALL_TIMEOUT_MS: "1000",
      BEADBOX_E2E_WAIT_POLL_MS: "50",
    })
    expect(r.code).toBe(1)
    expect(r.out).toContain(`pid ${holder.pid}`)
    expect(r.out).toContain("looks stuck")
    expect(holder.exitCode).toBeNull()
    expect(() => process.kill(holder.pid as number, 0)).not.toThrow()
  })
})
