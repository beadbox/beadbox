// Fail a release build whose client bundle carries the headless test transport
// (beadbox-7he). Usage: bun scripts/check-release-bundle.ts packages/client/dist
//
// The Vite guard (packages/client/vite-plugins/test-transport-guard.ts) is inert
// by design when the test flag is on, so a flag set in a release job's
// environment would ship the transport. This scan runs on the built files with
// no condition on any environment variable. It takes the marker and the match
// rule from the guard, so the two cannot drift.
//
// Positive control first: the dist must look like a Vite build (index.html, a
// chunk and a sourcemap), and a copy of it with the marker planted must be
// caught by the same scan. An empty or wrong path cannot pass silently.

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import {
  findTestTransport,
  TEST_TRANSPORT_MARKER,
} from "../packages/client/vite-plugins/test-transport-guard"

type Bundle = Parameters<typeof findTestTransport>[0]
export type Scan = { files: string[]; offenders: string[] }

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/** Every file under dir (relative, "/"-separated, sorted) and the ones that carry the test transport. */
export function scanDist(dir: string): Scan {
  const files = walk(dir)
    .map((f) => relative(dir, f).split(sep).join("/"))
    .sort()
  const bundle: Bundle = {}
  for (const f of files)
    bundle[f] = { type: "asset", source: new Uint8Array(readFileSync(join(dir, f))) }
  return { files, offenders: findTestTransport(bundle).sort() }
}

const PLANTED = "assets/beadbox-7he-control.js"

function control(dir: string, scan: (dir: string) => Scan): string | null {
  if (!existsSync(dir)) return `${dir} does not exist`
  const { files } = scan(dir)
  if (!files.includes("index.html"))
    return `${dir} has no index.html (${files.length} files): not a client build`
  if (!files.some((f) => f.endsWith(".js"))) return `${dir} has no .js chunk`
  if (!files.some((f) => f.endsWith(".js.map")))
    return `${dir} has no .js.map: sourcemaps must be scanned too`
  const copy = mkdtempSync(join(tmpdir(), "beadbox-7he-control-"))
  try {
    cpSync(dir, copy, { recursive: true })
    writeFileSync(join(copy, PLANTED), `window.${TEST_TRANSPORT_MARKER}`)
    const found = scan(copy).offenders
    if (!found.includes(PLANTED)) {
      return `the scan did not find the planted marker (found: ${found.join(", ") || "nothing"})`
    }
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
  return null
}

/** The control, then the real scan. `label` is the dist path printed in annotations. */
export function checkReleaseBundle(
  dir: string,
  label = dir,
  scan: (dir: string) => Scan = scanDist,
): { ok: boolean; messages: string[] } {
  const failed = control(dir, scan)
  if (failed) return { ok: false, messages: [`::error::control: ${failed}`] }
  const messages = ["control: found the planted marker in a copy of the dist"]
  const { files, offenders } = scan(dir)
  if (offenders.length === 0) {
    messages.push(`${files.length} files scanned, none carries the test transport`)
    return { ok: true, messages }
  }
  for (const f of offenders) {
    messages.push(
      `::error file=${label}/${f}::this release bundle carries the test transport (beadbox-7he)`,
    )
  }
  return { ok: false, messages }
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir) {
    console.error("usage: bun scripts/check-release-bundle.ts <client dist dir>")
    process.exit(2)
  }
  const { ok, messages } = checkReleaseBundle(dir)
  for (const m of messages) console.log(m)
  process.exit(ok ? 0 : 1)
}
