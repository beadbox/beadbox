// Every way the suites are run passes the 30 s default deadline as a flag
// (beadbox-mol-uua.1). bun 1.3.x ignores bunfig's [test] timeout, and a
// setDefaultTimeout in a preload holds for the first file of a process only;
// without the flag every later file ran on bun's 5 s, and on a loaded Mac
// tests that wait for real processes failed pushes on load, not code.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")
/** Each `bun test` / `bun --cwd=<pkg> test` command in a file: comments and echoed text left out. */
const invocations = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "")) // shell and YAML comments
    .filter((line) => !/^\s*echo\b/.test(line))
    .flatMap((line) => line.match(/\bbun (?:--cwd=\S+ )?test\b[^|&>]*/g) ?? [])

test("the package test scripts pass --timeout=30000", () => {
  for (const pkg of ["packages/server", "packages/client"]) {
    expect(JSON.parse(read(`${pkg}/package.json`)).scripts.test).toBe("bun test --timeout=30000")
  }
})

test("the hook, the shard runner and the coverage jobs pass it on every invocation", () => {
  const files = ["scripts/prepush-tests.sh", "scripts/ci-tests.sh", ".github/workflows/quality-gates.yml"]
  for (const file of files) {
    const runs = invocations(read(file))
    expect(runs.length).toBeGreaterThan(0) // the check sees the invocation it guards
    for (const run of runs) expect({ file, run }).toEqual({ file, run: expect.stringContaining("--timeout=30000") })
  }
})
