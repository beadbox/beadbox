// bench/ is a dev-only harness that starts `bd serve` (beadbox-6x2). The
// sidecar is compiled from src/index.ts, so it ships only what src/ imports.
// Nothing under src/ may import from bench/.

import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"

const SRC = dirname(import.meta.dir)

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

test("no file under src/ imports the dev-only bench harness", () => {
  const files = sources(SRC)
  expect(files.length).toBeGreaterThan(50)
  const offenders = files
    .filter((f) => f !== join(import.meta.dir, "bench-isolation.test.ts"))
    .filter((f) => /(?:from|import)\s*\(?\s*["'`][^"'`]*\/bench(?:\/|["'`])/.test(readFileSync(f, "utf-8")))
    .map((f) => relative(SRC, f))
  expect(offenders).toEqual([])
})
