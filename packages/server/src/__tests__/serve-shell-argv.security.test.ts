// The serve wrapper's shell script is a constant; the bd path and token dir
// reach it only as positionals (beadbox-6x2 L2, the rule
// change-detector-shell-argv.security.test.ts holds for the poll child).
// Hostile values must arrive at bd as literal argv and never be evaluated,
// and the wrapper's cleanup must refuse to remove anything that is not one of
// our token dirs.

import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildServeShellArgs, SERVE_DIR_PREFIX } from "../lib/serve-manager"

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

const HOSTILE = [
  "a b",
  "it's",
  'say "hi"',
  "$(touch PWNED_SUBST)",
  "`touch PWNED_BACKTICK`",
  "-rf",
  "semi;touch PWNED_SEMI",
  "line\nbreak",
]

/** A fake bd at `path` that records its argv (NUL-separated) and exits. */
function recordingBd(path: string, log: string): void {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\0' "$@" > '${log}'\n`)
  chmodSync(path, 0o700)
}

// Run the wrapper the way the sidecar does: detached, stdin held open (so the
// lifetime watcher does not fire), and let the fake bd exit on its own, which
// is the wrapper's other cleanup path.
async function runWrapper(bd: string, tokenDir: string): Promise<string[]> {
  const child = spawn("/bin/sh", buildServeShellArgs(bd, tokenDir), {
    cwd: root,
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  })
  await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.stdin?.destroy()
  const log = join(root, "argv.log")
  return existsSync(log) ? readFileSync(log, "utf-8").split("\0").slice(0, -1) : []
}

test("hostile bd paths and token dirs reach bd literally and are never evaluated", async () => {
  for (const hostile of HOSTILE) {
    root = mkdtempSync(join(tmpdir(), "beadbox-serve-argv-"))
    const bdDir = join(root, `bin ${hostile}`)
    mkdirSync(bdDir, { recursive: true })
    const bd = join(bdDir, "bd")
    recordingBd(bd, join(root, "argv.log"))
    const tokenDir = join(root, `${SERVE_DIR_PREFIX}${hostile}`)
    const argv = await runWrapper(bd, tokenDir)
    expect(argv).toEqual(["serve", "--addr", "127.0.0.1:0", "--auth-token-file", `${tokenDir}/token`])
    for (const marker of ["PWNED_SUBST", "PWNED_BACKTICK", "PWNED_SEMI"]) {
      expect(existsSync(join(root, marker))).toBe(false)
    }
    rmSync(root, { recursive: true, force: true })
  }
  root = mkdtempSync(join(tmpdir(), "beadbox-serve-argv-"))
})

// The test root is itself named beadbox-serve-argv-*: a parent that matches
// the prefix must NOT make a non-matching directory removable.
test("cleanup removes our token dir but refuses any other path", async () => {
  root = mkdtempSync(join(tmpdir(), "beadbox-serve-argv-"))
  const bd = join(root, "bd")
  recordingBd(bd, join(root, "argv.log"))

  const ours = join(root, `${SERVE_DIR_PREFIX}abc`)
  mkdirSync(ours)
  await runWrapper(bd, ours)
  expect(existsSync(ours)).toBe(false)

  const precious = join(root, "precious")
  mkdirSync(precious)
  writeFileSync(join(precious, "keep"), "x")
  await runWrapper(bd, precious)
  expect(existsSync(join(precious, "keep"))).toBe(true)
})
