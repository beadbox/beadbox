// sec's C2 lifetime condition (beadbox-6x2): however the sidecar ends, the
// bd serve child ends with it, its port stops answering, and its token dir is
// gone. A host process stands in for the sidecar and starts a real child
// through ServeManager (fake bd: fixtures/fake-bd-serve.py, a real socket).

import { afterEach, describe, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sweepStaleServeDirs } from "../lib/serve-manager"

const HOST = join(import.meta.dir, "fixtures", "serve-host.ts")
const FAKE_BD = join(import.meta.dir, "fixtures", "fake-bd-serve.py")
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

function portAnswers(url: string): Promise<boolean> {
  const port = Number(new URL(url).port)
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port }, () => {
      s.destroy()
      resolve(true)
    })
    s.on("error", () => resolve(false))
  })
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await Bun.sleep(50)
  }
  return check()
}

async function startHost(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "beadbox-serve-life-"))
  const host: ChildProcess = spawn(process.execPath, [HOST], {
    env: { ...process.env, HOST_MODE: mode, HOST_BD: FAKE_BD, HOST_WS: root, HOST_TOKEN_ROOT: root },
    stdio: ["ignore", "pipe", "inherit"],
  })
  cleanups.push(() => {
    host.kill("SIGKILL")
    rmSync(root, { recursive: true, force: true })
  })
  const info = await new Promise<{ wrapperPid: number; url: string; tokenDir: string }>((resolve, reject) => {
    let buf = ""
    host.stdout?.on("data", (d: Buffer) => {
      buf += d.toString()
      const m = /READY (\{.*\})\n/.exec(buf)
      if (m) resolve(JSON.parse(m[1]))
    })
    host.on("exit", (code) => reject(new Error(`host exited early (${code})`)))
  })
  cleanups.push(() => {
    try {
      process.kill(-info.wrapperPid, "SIGKILL")
    } catch {
      /* gone */
    }
  })
  return { host, info }
}

describe("a serve child ends with its sidecar", () => {
  for (const mode of ["kill-9", "exit", "crash"] as const) {
    test(`host ${mode}: child group gone, port refuses, token dir gone`, async () => {
      const { host, info } = await startHost(mode === "kill-9" ? "hang" : mode)
      // Preconditions, so a pass is not vacuous.
      expect(groupAlive(info.wrapperPid)).toBe(true)
      expect(await portAnswers(info.url)).toBe(true)
      expect(existsSync(info.tokenDir)).toBe(true)

      if (mode === "kill-9") host.kill("SIGKILL")
      expect(await until(() => !groupAlive(info.wrapperPid))).toBe(true)
      expect(await until(async () => !(await portAnswers(info.url)))).toBe(true)
      expect(await until(() => !existsSync(info.tokenDir))).toBe(true)
    }, 20_000)
  }
})

// sec (beadbox-6x2 L4): two instances side by side share TMPDIR. One
// instance's startup sweep must never delete the other's LIVE token dir.
test("a second running instance's live token dir survives our startup sweep", async () => {
  const { info } = await startHost("hang") // the other, still-running instance
  expect(existsSync(info.tokenDir)).toBe(true)
  const root = join(info.tokenDir, "..")
  const removed = sweepStaleServeDirs(root, new Set()) // our sweep, with no live dirs of our own
  expect(removed).not.toContain(info.tokenDir)
  expect(existsSync(info.tokenDir)).toBe(true)
  expect(await portAnswers(info.url)).toBe(true) // and its child is still serving
}, 20_000)
