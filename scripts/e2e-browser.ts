#!/usr/bin/env bun
// One shared, pinned browser for the headless e2e harness (beadbox-lvlz).
//
// Every clone on a machine uses the same Playwright browser install. A local
// run never downloads one: `run` checks the install first and fails fast with
// the command to run, and `install` is the one place a download happens,
// serialised by a lock that a dead holder cannot wedge.
//
//   bun scripts/e2e-browser.ts check            is the pinned browser installed?
//   bun scripts/e2e-browser.ts run [args...]    check, then `playwright test [args...]`
//   bun scripts/e2e-browser.ts install          install it once into the shared dir
//
// CI is untouched: there `run` passes straight through to `playwright test`
// and the workflow installs its own browser, as before.

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const PLAYWRIGHT_BIN = join(REPO_ROOT, "node_modules/.bin/playwright")
const INSTALL_COMMAND = "bun run e2e:browser:install"

const INSTALL_TIMEOUT_MS = Number(process.env.BEADBOX_E2E_INSTALL_TIMEOUT_MS) || 10 * 60_000
// A waiter gives up on a holder older than this: past it, the holder is stuck.
const HOLDER_MAX_AGE_MS = INSTALL_TIMEOUT_MS + 60_000
// A lock dir with no owner file is a crash between mkdir and the write.
const OWNERLESS_STALE_MS = 60_000
const WAIT_POLL_MS = Number(process.env.BEADBOX_E2E_WAIT_POLL_MS) || 2_000
const WAIT_REPORT_MS = 15_000

// One directory per machine, outside every clone and apart from the general
// ms-playwright cache, so other tools' Playwright versions and their install
// lock never contend with ours. BEADBOX_E2E_BROWSERS is for this script's tests.
export function sharedBrowsersDir(env = process.env, platform = process.platform): string {
  if (env.BEADBOX_E2E_BROWSERS) return env.BEADBOX_E2E_BROWSERS
  const cache =
    platform === "darwin"
      ? join(homedir(), "Library/Caches")
      : env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(cache, "beadbox-e2e-browsers")
}

export interface Pins {
  lockVersion: string | null // @playwright/test as bun.lock pins it
  installedVersion: string // playwright-core as installed in node_modules
  shellRevision: string // chromium-headless-shell revision that version wants
}

export function lockedPlaywrightVersion(lockText: string): string | null {
  return lockText.match(/"@playwright\/test": \["@playwright\/test@([^"]+)"/)?.[1] ?? null
}

// Follows @playwright/test -> playwright -> playwright-core, as the test
// runner does, so a version bump is seen as soon as bun install lands it.
export function readPins(root = REPO_ROOT): Pins {
  const testPkg = Bun.resolveSync("@playwright/test/package.json", root)
  const pwPkg = Bun.resolveSync("playwright/package.json", dirname(testPkg))
  const corePkg = Bun.resolveSync("playwright-core/package.json", dirname(pwPkg))
  const core = JSON.parse(readFileSync(corePkg, "utf8")) as { version: string }
  const browsers = JSON.parse(readFileSync(join(dirname(corePkg), "browsers.json"), "utf8")) as {
    browsers: { name: string; revision: string }[]
  }
  const shell = browsers.browsers.find((b) => b.name === "chromium-headless-shell")
  if (!shell) throw new Error("playwright-core's browsers.json lists no chromium-headless-shell")
  return {
    lockVersion: lockedPlaywrightVersion(readFileSync(join(root, "bun.lock"), "utf8")),
    installedVersion: core.version,
    shellRevision: shell.revision,
  }
}

export type CheckResult = { ok: true } | { ok: false; message: string }

// Playwright writes INSTALLATION_COMPLETE last; a directory without it is a
// partial or interrupted download.
export function checkBrowser(pins: Pins, dir: string): CheckResult {
  if (pins.lockVersion && pins.lockVersion !== pins.installedVersion) {
    return {
      ok: false,
      message:
        `e2e: bun.lock pins Playwright ${pins.lockVersion} but node_modules has ` +
        `${pins.installedVersion}. Run: bun install`,
    }
  }
  const marker = join(dir, `chromium_headless_shell-${pins.shellRevision}`, "INSTALLATION_COMPLETE")
  if (existsSync(marker)) return { ok: true }
  return {
    ok: false,
    message:
      `e2e: the browser for Playwright ${pins.installedVersion} (chromium-headless-shell ` +
      `r${pins.shellRevision}) is not installed in ${dir}. Install it once for every ` +
      `clone on this machine: ${INSTALL_COMMAND}`,
  }
}

// --- install lock ----------------------------------------------------------

export interface LockOwner {
  pid: number
  childPid?: number
  startedAt: number
}

const lockDir = (dir: string) => join(dir, ".install.lock")
const ownerFile = (dir: string) => join(lockDir(dir), "owner.json")

// Alive AND still one of ours: a recycled pid running something else is dead
// to us.
function isOurs(pid: number | undefined, pattern: RegExp): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })
  return pattern.test(ps.stdout ?? "")
}

export function readOwner(dir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(ownerFile(dir), "utf8")) as LockOwner
  } catch {
    return null
  }
}

// The lock is held while the wrapper that took it is alive, or while its
// playwright child is: if the wrapper died the child is still the installer,
// and a second download would only queue behind Playwright's own lock.
export function holderAlive(owner: LockOwner): boolean {
  return isOurs(owner.pid, /e2e-browser/) || isOurs(owner.childPid, /playwright/)
}

export type Acquire = { taken: true; stale?: string } | { taken: false; owner: LockOwner | null }

export function tryAcquire(dir: string, now = Date.now()): Acquire {
  mkdirSync(dir, { recursive: true })
  let stale: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir(dir))
      writeOwner(dir, { pid: process.pid, startedAt: now })
      return stale ? { taken: true, stale } : { taken: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
    const owner = readOwner(dir)
    if (owner) {
      if (holderAlive(owner)) return { taken: false, owner }
      stale = `pid ${owner.pid} (started ${new Date(owner.startedAt).toISOString()}) is gone`
    } else {
      const age = now - statSync(lockDir(dir)).mtimeMs
      if (age < OWNERLESS_STALE_MS) return { taken: false, owner: null }
      stale = `lock with no owner, ${Math.round(age / 1000)} s old`
    }
    rmSync(lockDir(dir), { recursive: true, force: true })
  }
  return { taken: false, owner: readOwner(dir) }
}

function writeOwner(dir: string, owner: LockOwner) {
  writeFileSync(ownerFile(dir), JSON.stringify(owner))
}

function release(dir: string) {
  if (readOwner(dir)?.pid === process.pid) rmSync(lockDir(dir), { recursive: true, force: true })
}

// --- commands ----------------------------------------------------------------

function check(): number {
  if (process.env.E2E_CHROMIUM) return 0 // an explicit executable; nothing to check
  const result = checkBrowser(readPins(), sharedBrowsersDir())
  if (!result.ok) console.error(result.message)
  return result.ok ? 0 : 1
}

function run(args: string[]): Promise<number> {
  const env = { ...process.env }
  if (!process.env.CI) {
    const code = check()
    if (code !== 0) return Promise.resolve(code)
    // Overrides any per-agent value: no run uses a scratch copy.
    env.PLAYWRIGHT_BROWSERS_PATH = sharedBrowsersDir()
  }
  return spawnForward(PLAYWRIGHT_BIN, ["test", ...args], env)
}

function spawnForward(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: "inherit" })
  const forward = (sig: NodeJS.Signals) => child.kill(sig)
  process.on("SIGINT", forward)
  process.on("SIGTERM", forward)
  return new Promise((done) => child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0))))
}

async function install(): Promise<number> {
  const dir = sharedBrowsersDir()
  const pins = readPins()
  const installed = () => checkBrowser(pins, dir).ok

  if (installed()) {
    console.log(`e2e: chromium-headless-shell r${pins.shellRevision} already installed in ${dir}`)
    return 0
  }

  let lastReport = 0
  for (;;) {
    const got = tryAcquire(dir)
    if (got.taken) {
      if (got.stale) console.log(`e2e: removed a stale install lock (${got.stale})`)
      break
    }
    if (installed()) {
      console.log(`e2e: installed by another run in ${dir}`)
      return 0
    }
    const owner = got.owner
    if (owner && Date.now() - owner.startedAt > HOLDER_MAX_AGE_MS) {
      console.error(
        `e2e: the install by pid ${owner.pid}${owner.childPid ? ` (playwright pid ${owner.childPid})` : ""} ` +
          `has run ${Math.round((Date.now() - owner.startedAt) / 60_000)} min and looks stuck. ` +
          "This command does not stop another agent's process; ask its owner, then rerun.",
      )
      return 1
    }
    if (Date.now() - lastReport >= WAIT_REPORT_MS) {
      console.log(`e2e: waiting for the install by pid ${owner?.pid ?? "(starting)"} to finish`)
      lastReport = Date.now()
    }
    await Bun.sleep(WAIT_POLL_MS)
  }

  try {
    if (installed()) return 0 // finished between our check and the lock
    console.log(`e2e: installing chromium-headless-shell r${pins.shellRevision} into ${dir}`)
    // Under bun, not the CLI's `node` shebang: on Node 26 (Homebrew) the
    // download completes but extraction stalls after the first two files,
    // holding the lock forever; under bun the same install finishes in
    // seconds (beadbox-lvlz).
    // Its own process group: Playwright downloads in a helper process, and a
    // timeout or Ctrl-C must stop that too. Only this group is ever signalled.
    const child = spawn(process.execPath, [PLAYWRIGHT_BIN, "install", "--only-shell", "chromium"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir },
      stdio: "inherit",
      detached: true,
    })
    const owner = readOwner(dir)
    if (owner && child.pid) writeOwner(dir, { ...owner, childPid: child.pid })
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {}
    }
    const timer = setTimeout(() => signalGroup("SIGKILL"), INSTALL_TIMEOUT_MS)
    const forward = (sig: NodeJS.Signals) => signalGroup(sig)
    process.on("SIGINT", forward)
    process.on("SIGTERM", forward)
    const code = await new Promise<number>((done) =>
      child.on("exit", (c, signal) => done(c ?? (signal ? 1 : 0))),
    )
    clearTimeout(timer)
    if (code === 0 && installed()) return 0
    console.error(`e2e: the install did not complete (exit ${code}); rerun ${INSTALL_COMMAND}`)
    return 1
  } finally {
    release(dir)
  }
}

async function main(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case "check":
      return check()
    case "run":
      return run(args)
    case "install":
      return install()
    default:
      console.error("usage: bun scripts/e2e-browser.ts check | run [args...] | install")
      return 2
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  process.exit(await main(command, args))
}
