// sec's R5 (beadbox-6x2): the attributed proxy reap with real processes, no
// real bd needed. A generated `bd` mimics bd 1.3.x's argv shapes: `bd serve`
// starts `bd db-proxy-child --root <ws>/.beads/dolt` in ITS OWN session (so it
// survives the serve's process group, as the real one does), then runs the
// fake server. Cases:
//   1. our recorded proxy is reaped after our serve stops;
//   2. a proxy for a DIFFERENT root survives;
//   3. a proxy with a live foreign bd serve on the same root survives;
//   4. an unrecorded (user-started) proxy survives;
//   5. sidecar death: the next startup sweep reaps the recorded proxy.
// (A reused pid is covered by the pure decision tests: it cannot be forced here.)

import { afterEach, beforeEach, expect, test } from "bun:test"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ServeManager, sweepStaleServeProxies } from "../lib/serve-manager"
import { processTable } from "../lib/serve-proxy"

const FAKE_SERVE = join(import.meta.dir, "fixtures", "fake-bd-serve.py")
const HOST = join(import.meta.dir, "fixtures", "serve-host.ts")
let root: string
let bd: string
let manager: ServeManager | null = null
const extra: ChildProcess[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "beadbox-proxy-reap-")))
  mkdirSync(join(root, "bin"))
  bd = join(root, "bin", "bd")
  writeFileSync(
    bd,
    `#!/bin/sh
case "$1" in
  serve)
    [ -n "$FAKE_FOREIGN_SERVE" ] && while :; do sleep 1; done
    python3 -c 'import os,sys; os.setsid(); os.execv("/bin/sh", ["/bin/sh", sys.argv[1], "db-proxy-child", "--root", sys.argv[2]])' "$0" "$PWD/.beads/dolt" </dev/null >/dev/null 2>&1 &
    python3 '${FAKE_SERVE}' "$@"
    ;;
  db-proxy-child) while :; do sleep 1; done ;;
esac
`,
  )
  chmodSync(bd, 0o755)
})

afterEach(async () => {
  await manager?.stopAll()
  manager = null
  for (const p of extra.splice(0)) p.kill("SIGKILL")
  // Anything this test's bd started, by its unique path: nothing may outlive the test.
  for (const r of processTable()) if (r.command.includes(bd)) process.kill(r.pid, "SIGKILL")
  rmSync(root, { recursive: true, force: true })
})

function workspace(name: string): string {
  const ws = join(root, name)
  mkdirSync(join(ws, ".beads", "dolt"), { recursive: true })
  return ws
}
const proxiesFor = (ws: string) =>
  processTable().filter((r) => r.command.includes(bd) && r.command.includes("db-proxy-child") && r.command.includes(`${ws}/.beads/dolt`))
/** Alive and not a zombie: a killed child of this test can linger as Z in ps until it is reaped. */
function alive(pid: number): boolean {
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" }).trim()
    return stat !== "" && !stat.startsWith("Z")
  } catch {
    return false
  }
}
/** "Survives" means it stays alive for the whole window, not at a single instant. */
async function survives(pid: number, ms = 1000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return false
    await Bun.sleep(50)
  }
  return alive(pid)
}
async function until(check: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end && !check()) await Bun.sleep(50)
  return check()
}
async function startOurs(ws: string, key = "ws") {
  manager ??= new ServeManager({ bdPath: () => bd, tokenRoot: root })
  const h = await manager.get({ key, workspaceDir: ws, env: {} })
  expect(await until(() => proxiesFor(ws).length === 1)).toBe(true)
  manager.noteHealthy(key)
  const [dir] = [...manager.liveTokenDirs()]
  expect(existsSync(join(dir, "proxy.json"))).toBe(true) // precondition: recorded
  return { h, dir, proxy: proxiesFor(ws)[0].pid }
}
/** A proxy nobody recorded: started by "the user", in its own session. */
function userProxy(ws: string): ChildProcess {
  const p = spawn("python3", ["-c", `import os; os.setsid(); os.execv("/bin/sh", ["/bin/sh", "${bd}", "db-proxy-child", "--root", "${ws}/.beads/dolt"])`], { stdio: "ignore" })
  extra.push(p)
  return p
}

test("1. our recorded proxy is reaped after our serve stops", async () => {
  const ws = workspace("a")
  const { proxy } = await startOurs(ws)
  await manager?.stop("ws")
  expect(await until(() => !alive(proxy))).toBe(true)
})

test("2. a proxy for a DIFFERENT root survives our reap", async () => {
  const ws = workspace("a")
  const other = workspace("b")
  userProxy(other)
  expect(await until(() => proxiesFor(other).length === 1)).toBe(true)
  const theirs = proxiesFor(other)[0].pid
  const { proxy } = await startOurs(ws)
  await manager?.stop("ws")
  expect(await until(() => !alive(proxy))).toBe(true)
  expect(await survives(theirs)).toBe(true)
})

test("3. with a live foreign bd serve on the same root, our proxy is left alone", async () => {
  const ws = workspace("a")
  const { proxy } = await startOurs(ws)
  const foreign = spawn(bd, ["serve", "--foreign"], { cwd: ws, env: { ...process.env, FAKE_FOREIGN_SERVE: "1" }, stdio: "ignore" })
  extra.push(foreign)
  await Bun.sleep(300)
  await manager?.stop("ws")
  expect(await survives(proxy)).toBe(true)
})

test("4. an unrecorded (user-started) proxy on the same root survives", async () => {
  const ws = workspace("a")
  const { proxy } = await startOurs(ws)
  userProxy(ws)
  expect(await until(() => proxiesFor(ws).length === 2)).toBe(true)
  const users = proxiesFor(ws).find((r) => r.pid !== proxy)?.pid as number
  await manager?.stop("ws")
  expect(await until(() => !alive(proxy))).toBe(true)
  expect(await survives(users)).toBe(true)
})

test("5. sidecar death: the token goes at once, and the next startup sweep reaps the recorded proxy", async () => {
  const ws = workspace("a")
  const tokenRoot = join(root, "tok")
  mkdirSync(tokenRoot)
  const host = spawn(process.execPath, [HOST], {
    env: { ...process.env, HOST_MODE: "hang", HOST_BD: bd, HOST_WS: ws, HOST_TOKEN_ROOT: tokenRoot, HOST_NOTE_HEALTHY: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  })
  extra.push(host)
  const info = await new Promise<{ tokenDir: string }>((resolve, reject) => {
    let buf = ""
    host.stdout?.on("data", (d: Buffer) => {
      buf += d.toString()
      const m = /READY (\{.*\})\n/.exec(buf)
      if (m) resolve(JSON.parse(m[1]))
    })
    host.on("exit", (c) => reject(new Error(`host exited ${c}`)))
  })
  expect(await until(() => existsSync(join(info.tokenDir, "proxy.json")))).toBe(true)
  const proxy = JSON.parse(readFileSync(join(info.tokenDir, "proxy.json"), "utf-8")).pid as number
  host.kill("SIGKILL")
  expect(await until(() => !existsSync(join(info.tokenDir, "token")))).toBe(true) // the secret goes at once
  expect(existsSync(join(info.tokenDir, "proxy.json"))).toBe(true) // the record waits for the sweep
  expect(alive(proxy)).toBe(true) // its own session: the group kill missed it
  const outcomes = await sweepStaleServeProxies(tokenRoot)
  expect(outcomes.join()).toContain("reaped")
  expect(await until(() => !alive(proxy))).toBe(true)
  expect(existsSync(info.tokenDir)).toBe(false)
}, 20_000)
