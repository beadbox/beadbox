// The sidecar's shutdown stamp must never carry another process's command
// line (beadbox-9j1). It used to print `ps ... command` and `pgrep -l -f`
// output, i.e. full argv, into stderr, which the sidecar mirrors into its
// persistent log; on a real machine that captured another program's API key.
//
// This drives the REAL sidecar entry end to end: a synthetic process whose
// argv matches the old pgrep pattern and carries a fake secret-shaped string
// is running, the sidecar gets SIGTERM, and the log file it wrote is read.
// The secret is fake by construction; never put a real one in a test.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { type Subprocess, spawn } from "bun"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

setDefaultTimeout(30_000)

const FAKE_SECRET = `sk-fake-${"0123456789abcdef".repeat(4)}`
const FAKE_ENV_SECRET = `envfake-${"fedcba9876543210".repeat(4)}`
const FAKE_DB_PASSWORD = `dbpass-fake-${"a1b2c3d4".repeat(6)}`
const SIDECAR_ENTRY = join(dirname(import.meta.dir), "index.ts")

const children: Subprocess[] = []
let root: string | undefined

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
  }
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function readUntil(stream: ReadableStream<Uint8Array>, done: (text: string) => boolean, ms: number) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + ms
  try {
    while (!done(text) && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now())),
      ])
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  return text
}

test("the shutdown stamp names processes by pid and name only, never by command line", async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-9j1-"))
  const logPath = join(root, "beadbox-sidecar.log")

  // Matches the old `pgrep -f '[Bb]eadbox|tauri'`, with a secret-shaped arg.
  // A compound command keeps sh (and this argv) alive; `sh -c "sleep 60"`
  // would exec into sleep and lose it.
  // It carries the secret in argv (a flag and an env-style assignment) and in
  // its real environment.
  const synthetic = spawn(
    ["sh", "-c", "sleep 60; :", "beadbox-synthetic", `--api-key=${FAKE_SECRET}`, `API_TOKEN=${FAKE_ENV_SECRET}`],
    { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, API_TOKEN: FAKE_ENV_SECRET } },
  )
  children.push(synthetic)

  // Shaped like our own server-mode poll child for a password-protected
  // workspace: /bin/sh looping over bd, the db password in its environment.
  const pollChild = spawn(
    ["/bin/sh", "-c", "while :; do sleep 1; done", "bd", "sql", "--db", "/tmp/beadbox-synthetic-ws/.beads/dolt"],
    { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, BEADS_DOLT_PASSWORD: FAKE_DB_PASSWORD } },
  )
  children.push(pollChild)

  const sidecar = spawn(["bun", SIDECAR_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BEADBOX_LOG_PATH: logPath },
  })
  children.push(sidecar)

  const boot = await readUntil(sidecar.stderr as ReadableStream<Uint8Array>, (t) => t.includes("[beadbox-sidecar] starting"), 15_000)
  expect(boot).toContain("[beadbox-sidecar] starting")
  // "starting" is printed before the SIGTERM handler is installed; a signal
  // sent that early takes the default action and no stamp is written.
  await Bun.sleep(2_500)

  sidecar.kill("SIGTERM")
  const rest = await readUntil(sidecar.stderr as ReadableStream<Uint8Array>, (t) => t.includes("shutting down"), 10_000)
  await Promise.race([sidecar.exited, new Promise((r) => setTimeout(r, 5_000))])

  const stderr = boot + rest
  const log = await readFile(logPath, "utf-8")
  const stamp = log.split("\n").find((line) => line.includes("[bb-0vlu] sigterm_received")) ?? ""

  // The stamp is still written, in the log file users attach to reports.
  expect(stamp).not.toBe("")
  // Known-good control: the capture still sees both processes...
  expect(stamp).toContain(String(synthetic.pid))
  expect(stamp).toContain(String(pollChild.pid))
  // ...but never their command lines or environments.
  for (const secret of [FAKE_SECRET, FAKE_ENV_SECRET, FAKE_DB_PASSWORD]) {
    expect(log).not.toContain(secret)
    expect(stderr).not.toContain(secret)
  }
  expect(stamp).not.toContain("--api-key")
  expect(stamp).not.toContain("BEADS_DOLT_PASSWORD")
  // Every process entry is exactly "pid ppid name".
  const procs = /beadboxProcs="([^"]*)"/.exec(stamp)?.[1] ?? ""
  for (const entry of procs.split("\\n").filter(Boolean)) expect(entry).toMatch(/^\d+ \d+ \S+$/)
  // The parent chain names processes; it does not print the sidecar's argv.
  expect(stamp).not.toContain("src/index.ts")
})
