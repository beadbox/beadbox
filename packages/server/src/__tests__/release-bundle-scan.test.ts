// The release workflow's dist scan (beadbox-7he): every job that builds shipped
// client bytes fails if they carry the test transport, whatever the environment
// says. The Vite guard is inert by design when the test flag is on, so this
// scan runs on the built files with no condition at all.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkReleaseBundle, scanDist } from "../../../../scripts/check-release-bundle"
import { TEST_TRANSPORT_MARKER } from "../../../client/vite-plugins/test-transport-guard"

const REPO = join(import.meta.dir, "..", "..", "..", "..")
const SCRIPT = join(REPO, "scripts", "check-release-bundle.ts")
const RELEASE = join(REPO, ".github", "workflows", "release.yml")
const ARM_DMG = join(REPO, ".github", "workflows", "build-arm-dmg.yml")

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A synthetic dist shaped like Vite's: index.html, a chunk and its sourcemap. */
function dist(extra: Record<string, string | Uint8Array> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "beadbox-7he-"))
  dirs.push(root)
  const files: Record<string, string | Uint8Array> = {
    "index.html": "<!doctype html><script src=/assets/index-a1.js></script>",
    "assets/index-a1.js": "console.log('app')",
    "assets/index-a1.js.map": '{"sourcesContent":["app"]}',
    ...extra,
  }
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

describe("scanDist", () => {
  test("a clean dist has no offenders, and the walk saw every file", () => {
    expect(scanDist(dist())).toEqual({
      files: ["assets/index-a1.js", "assets/index-a1.js.map", "index.html"],
      offenders: [],
    })
  })

  test("names the marker in a chunk, a sourcemap and a binary file, and a test-transport chunk by name", () => {
    const root = dist({
      "assets/lazy-b2.js": `w.${TEST_TRANSPORT_MARKER}`,
      "assets/lazy-b2.js.map": `{"sourcesContent":["${TEST_TRANSPORT_MARKER}"]}`,
      "assets/blob.bin": new TextEncoder().encode(TEST_TRANSPORT_MARKER),
      "assets/test-transport-c3.js": "",
    })
    expect(scanDist(root).offenders).toEqual([
      "assets/blob.bin",
      "assets/lazy-b2.js",
      "assets/lazy-b2.js.map",
      "assets/test-transport-c3.js",
    ])
  })
})

describe("checkReleaseBundle", () => {
  test("passes a clean dist, after the control finds its planted file", () => {
    const result = checkReleaseBundle(dist())
    expect(result.ok).toBe(true)
    expect(result.messages.join("\n")).toMatch(/control: found the planted marker/)
    expect(result.messages.join("\n")).toMatch(/3 files scanned, none carries the test transport/)
  })

  test("fails a dist carrying the transport, naming each file under its dist path", () => {
    const root = dist({ "assets/lazy-b2.js.map": `["${TEST_TRANSPORT_MARKER}"]` })
    const result = checkReleaseBundle(root, "packages/client/dist")
    expect(result.ok).toBe(false)
    expect(result.messages).toContain(
      "::error file=packages/client/dist/assets/lazy-b2.js.map::this release bundle carries the test transport (beadbox-7he)",
    )
  })

  test("the control fails a missing dist", () => {
    const result = checkReleaseBundle(join(tmpdir(), "beadbox-7he-does-not-exist"))
    expect(result.ok).toBe(false)
    expect(result.messages.join("\n")).toMatch(/control: .*does not exist/)
  })

  test("the control fails an empty dist", () => {
    const root = mkdtempSync(join(tmpdir(), "beadbox-7he-"))
    dirs.push(root)
    const result = checkReleaseBundle(root)
    expect(result.ok).toBe(false)
    expect(result.messages.join("\n")).toMatch(/control: .*index\.html/)
  })

  test("the control fails a dist without sourcemaps (they must be scanned too)", () => {
    const root = dist()
    rmSync(join(root, "assets", "index-a1.js.map"))
    const result = checkReleaseBundle(root)
    expect(result.ok).toBe(false)
    expect(result.messages.join("\n")).toMatch(/control: .*\.js\.map/)
  })

  test("the control fails a scan that cannot find the planted marker", () => {
    const blind = (dir: string) => ({ ...scanDist(dir), offenders: [] })
    const result = checkReleaseBundle(dist(), "dist", blind)
    expect(result.ok).toBe(false)
    expect(result.messages.join("\n")).toMatch(/control: the scan did not find the planted marker/)
  })

  test("the control leaves the real dist untouched", () => {
    const root = dist()
    checkReleaseBundle(root)
    expect(scanDist(root).files).toEqual([
      "assets/index-a1.js",
      "assets/index-a1.js.map",
      "index.html",
    ])
  })
})

describe("the workflows run the scan after every shipped SPA build", () => {
  const STEP = "bun scripts/check-release-bundle.ts packages/client/dist"

  // Every job whose SPA build ends up in a shipped bundle. test-integration's build ships nothing.
  const cases: Array<[string, string, string]> = [
    [RELEASE, "build-macos-arm64", "bun --cwd=packages/client run build"],
    [RELEASE, "build-linux", "bun --cwd=packages/client run build"],
    [RELEASE, "build-windows", "bun run build"],
    [ARM_DMG, "build", "bun --cwd=packages/client run build"],
  ]

  function job(path: string, name: string): string {
    const text = readFileSync(path, "utf-8")
    const start = text.search(new RegExp(`^  ${name}:\\n`, "m"))
    expect(start).toBeGreaterThan(-1)
    const next = text.slice(start + 1).search(/^ {2}[a-z][a-z0-9-]*:\n/m)
    return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next)
  }

  for (const [path, name, build] of cases) {
    test(`${path.split("/").pop()} ${name}: the scan is the step right after Build SPA, with no condition`, () => {
      const body = job(path, name)
      const buildAt = body.indexOf(build)
      const scanAt = body.indexOf(STEP)
      expect(buildAt).toBeGreaterThan(-1)
      expect(scanAt).toBeGreaterThan(buildAt)
      // Nothing between the build and the scan but the end of the build step and the scan step's header.
      const between = body.slice(buildAt, scanAt)
      expect(between.match(/^\s*- name:/gm)?.length).toBe(1)
      const step = body.slice(body.lastIndexOf("- name:", scanAt), scanAt)
      expect(step).not.toMatch(/^\s*if:/m)
    })
  }

  test("the shipped SPA builds are exactly the ones above", () => {
    const release = readFileSync(RELEASE, "utf-8")
    // macOS, Linux, Windows, plus test-integration (not shipped).
    expect(
      release.match(/^\s*(?:run: )?bun (?:--cwd=packages\/client )?run build$/gm)?.length,
    ).toBe(4)
    expect(release.split(STEP).length - 1).toBe(3)
    expect(readFileSync(ARM_DMG, "utf-8").split(STEP).length - 1).toBe(1)
  })

  test("the script takes the marker from the guard and does not spell it", () => {
    const script = readFileSync(SCRIPT, "utf-8")
    expect(script).toContain("packages/client/vite-plugins/test-transport-guard")
    expect(script).not.toContain(TEST_TRANSPORT_MARKER)
  })
})
