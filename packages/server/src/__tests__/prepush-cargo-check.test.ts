// beadbox-mol-0zm: the pre-push Rust compile check
// (`scripts/prepush-cargo-check.sh`). Rust coverage left the push run for
// the nightly, so this check is what stops a src-tauri compile error before
// main. It must run cargo check exactly when the pushed range changes
// src-tauri/, fail the push when cargo does, and run (not skip) when it
// cannot read the range.
//
// Approach: a scratch git repo with an origin/main ref, the real script run
// in it, and stub cargo/rustc first on PATH. The stub cargo records its argv
// and exits with $STUB_CARGO_EXIT, so a compile error is an exit code, not a
// real broken crate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const SCRIPT = resolve(import.meta.dir, "../../../../scripts/prepush-cargo-check.sh")
const ZERO = "0000000000000000000000000000000000000000"
const GIT = Bun.which("git") ?? "/usr/bin/git"

let root: string
let repo: string
let stubs: string
let log: string

function git(...args: string[]): string {
  const p = Bun.spawnSync({ cmd: [GIT, ...args], cwd: repo, stdout: "pipe", stderr: "pipe" })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}

function commit(path: string, body: string): string {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), body)
  git("add", path)
  git("commit", "-q", "-m", path)
  return git("rev-parse", "HEAD")
}

function run(specs: string, opts: { cargo?: boolean; cargoExit?: number } = {}) {
  const path = [opts.cargo === false ? join(root, "no-cargo") : stubs, dirname(GIT), "/usr/bin", "/bin"].join(":")
  const p = Bun.spawnSync({
    cmd: ["bash", SCRIPT],
    cwd: repo,
    env: { PATH: path, HOME: root, PUSH_SPECS: specs, STUB_CARGO_EXIT: String(opts.cargoExit ?? 0) },
    stdout: "pipe",
    stderr: "pipe",
  })
  const calls = existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean) : []
  return { exitCode: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), calls }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beadbox-0zm-"))
  repo = join(root, "repo")
  stubs = join(root, "stubs")
  log = join(root, "cargo.log")
  mkdirSync(repo)
  mkdirSync(stubs)
  mkdirSync(join(root, "no-cargo"))
  writeFileSync(join(stubs, "cargo"), `#!/bin/sh\necho "$*" >> "${log}"\nexit "$STUB_CARGO_EXIT"\n`)
  writeFileSync(join(stubs, "rustc"), "#!/bin/sh\necho 'host: test-triple'\n")
  writeFileSync(join(root, "no-cargo", "rustc"), "#!/bin/sh\necho 'host: test-triple'\n")
  for (const f of [join(stubs, "cargo"), join(stubs, "rustc"), join(root, "no-cargo", "rustc")]) chmodSync(f, 0o755)
  git("init", "-q", "-b", "main")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  commit("README.md", "base\n")
  git("update-ref", "refs/remotes/origin/main", "HEAD")
  // The sidecar tauri-build needs: untracked, as in a real clone.
  mkdirSync(join(repo, "src-tauri", "binaries"), { recursive: true })
  writeFileSync(join(repo, "src-tauri", "binaries", "beadbox-sidecar-test-triple"), "")
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("pre-push cargo check (scripts/prepush-cargo-check.sh)", () => {
  test("a push that changes src-tauri/ runs cargo check on the host crate", () => {
    const base = git("rev-parse", "HEAD")
    const head = commit("src-tauri/src/lib.rs", "fn main() {}\n")
    const r = run(`${base} ${head}`)
    expect(r.exitCode).toBe(0)
    expect(r.calls).toEqual(["check --manifest-path src-tauri/Cargo.toml"])
    expect(r.out).toContain("this push changes src-tauri/")
  })

  test("a push that does not change src-tauri/ skips it", () => {
    const base = git("rev-parse", "HEAD")
    const head = commit("packages/server/src/x.ts", "export {}\n")
    const r = run(`${base} ${head}`)
    expect(r.exitCode).toBe(0)
    expect(r.calls).toEqual([])
    expect(r.out).toContain("cargo check skipped")
  })

  test("a compile error fails the push with cargo's exit code", () => {
    const base = git("rev-parse", "HEAD")
    const head = commit("src-tauri/src/lib.rs", "fn main( {}\n")
    const r = run(`${base} ${head}`, { cargoExit: 101 })
    expect(r.exitCode).toBe(101)
    expect(r.calls).toHaveLength(1)
  })

  test("a new branch is judged against its merge-base with origin/main", () => {
    commit("src-tauri/Cargo.toml", "[package]\n")
    const head = git("rev-parse", "HEAD")
    expect(run(`${ZERO} ${head}`).calls).toHaveLength(1)
  })

  test("a base this clone does not have runs the check (fail safe)", () => {
    const head = commit("packages/x.ts", "export {}\n")
    const r = run(`${"1".repeat(40)} ${head}`)
    expect(r.calls).toHaveLength(1)
    expect(r.out).toContain("is not in this clone")
  })

  test("a src-tauri change without cargo installed is refused, not skipped", () => {
    const base = git("rev-parse", "HEAD")
    const head = commit("src-tauri/src/lib.rs", "fn main() {}\n")
    const r = run(`${base} ${head}`, { cargo: false })
    expect(r.exitCode).toBe(1)
    expect(r.out).toContain("cargo is not installed")
  })

  test("a src-tauri change without the sidecar tauri-build needs is refused, and none is created", () => {
    rmSync(join(repo, "src-tauri", "binaries", "beadbox-sidecar-test-triple"))
    const base = git("rev-parse", "HEAD")
    const head = commit("src-tauri/src/lib.rs", "fn main() {}\n")
    const r = run(`${base} ${head}`)
    expect(r.exitCode).toBe(1)
    expect(r.calls).toEqual([])
    expect(r.out).toContain("build:sidecar")
    expect(existsSync(join(repo, "src-tauri", "binaries", "beadbox-sidecar-test-triple"))).toBe(false)
  })

  test("a deletion-only spec changes nothing, so the check is skipped", () => {
    const head = git("rev-parse", "HEAD")
    expect(run(`${head} ${ZERO}`).calls).toEqual([])
  })
})
