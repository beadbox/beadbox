// Security invariant (systemdesign §3.4 + §7.2, beadbox-r72.2): the headless
// test transport can never reach a shipped build.
//
// packages/client/src/lib/test-transport.ts drives the sidecar through a
// Playwright binding. It is reached only by one dynamic import() inside the
// branch that the build-time constant __BEADBOX_TEST_TRANSPORT__ compiles out,
// and the Vite guard (vite-plugins/test-transport-guard.ts) fails any build
// with the flag off that still carries it. This file pins the structure that
// makes those two hold: one import site, one flag source, no release path that
// turns the flag on, and nothing in the module that could listen or fetch.

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const REPO = join(import.meta.dir, "..", "..", "..", "..")
const CLIENT = join(REPO, "packages", "client")
const CLIENT_SRC = join(CLIENT, "src")
const SEAM = join(CLIENT_SRC, "lib", "sidecar-transport.ts")
const MODULE = join(CLIENT_SRC, "lib", "test-transport.ts")
const GUARD = join(CLIENT, "vite-plugins", "test-transport-guard.ts")
const VITE_CONFIG = join(CLIENT, "vite.config.ts")
const WORKFLOWS = join(REPO, ".github", "workflows")
const MARKER = "__beadboxTestBridge"
const FLAG_ENV = "BEADBOX_TEST_TRANSPORT"

function files(dir: string, keep: (name: string) => boolean, skipTests = true): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "target") continue
      if (skipTests && entry === "__tests__") continue
      out.push(...files(full, keep, skipTests))
    } else if (keep(entry)) out.push(full)
  }
  return out
}

const isSource = (name: string) => /\.(ts|tsx|mts|js|mjs)$/.test(name)
const read = (path: string) => readFileSync(path, "utf-8")
const rel = (path: string) => relative(REPO, path)

const clientProduction = files(CLIENT_SRC, isSource)
const IMPORT_OF_MODULE = /(?:\bfrom\s*|\bimport\s*\(\s*)["'][^"']*\btest-transport["']/g

describe("one guarded import site", () => {
  test("the sweep finds client production source (guards against an empty scan)", () => {
    expect(clientProduction.length).toBeGreaterThan(50)
    expect(clientProduction).toContain(SEAM)
    expect(clientProduction).toContain(MODULE)
  })

  test("only lib/sidecar-transport.ts imports the test transport, and only dynamically, once", () => {
    const importers = clientProduction.filter((f) => IMPORT_OF_MODULE.test(read(f))).map(rel)
    IMPORT_OF_MODULE.lastIndex = 0
    expect(importers).toEqual([rel(SEAM)])
    const seam = read(SEAM)
    expect(seam.match(IMPORT_OF_MODULE)?.length).toBe(1)
    expect(seam).not.toMatch(/\bfrom\s*["'][^"']*test-transport["']/)
    expect(seam).toContain('import("./test-transport")')
  })

  test("that import sits in the lazy loader, and the loader is used only behind the build-time flag", () => {
    const seam = read(SEAM)
    const loader = seam.indexOf("function lazyTestTransport(")
    const importAt = seam.indexOf('import("./test-transport")')
    const gate = seam.indexOf("const testTransport = TEST_TRANSPORT ? lazyTestTransport() : null")
    expect(loader).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(-1)
    expect(importAt).toBeGreaterThan(loader)
    expect(importAt).toBeLessThan(gate)
    // lazyTestTransport: its definition plus the one gated call.
    expect(seam.match(/\blazyTestTransport\b/g)?.length).toBe(2)
    expect(seam).toMatch(
      /const TEST_TRANSPORT = typeof __BEADBOX_TEST_TRANSPORT__ === "boolean" && __BEADBOX_TEST_TRANSPORT__\n/,
    )
  })

  test("the marker the build guard looks for is spelled only in the test transport", () => {
    // Sourcemaps embed every bundled module's source, so the seam must not spell it even in a comment.
    const spellers = clientProduction.filter((f) => read(f).includes(MARKER)).map(rel)
    expect(spellers).toEqual([rel(MODULE)])
    expect(read(GUARD)).toContain(`TEST_TRANSPORT_MARKER = "${MARKER}"`)
  })
})

describe("one flag source", () => {
  const scanned = [
    ...files(join(REPO, "packages"), isSource),
    ...files(join(REPO, "scripts"), (n) => isSource(n) || /\.(sh|py)$/.test(n)),
    ...files(WORKFLOWS, (n) => /\.ya?ml$/.test(n)),
  ]

  test("the environment variable is read in exactly one place: the guard's testTransportEnabled()", () => {
    const readers = scanned
      .filter((f) => /env(?:\.|\[\s*["'])BEADBOX_TEST_TRANSPORT\b/.test(read(f)))
      .map(rel)
    expect(readers).toEqual([rel(GUARD)])
    expect(read(GUARD)).toContain(`return env.${FLAG_ENV} === "1"`)
  })

  test("the build-time constant is defined only by vite.config.ts, from that one reader", () => {
    // A define key: an object property at the start of a line (not the env.d.ts type, not a comment).
    const definers = scanned
      .filter((f) => /^\s*["']?__BEADBOX_TEST_TRANSPORT__["']?\s*:/m.test(read(f)))
      .map(rel)
    expect(definers).toEqual([rel(VITE_CONFIG)])
    const config = read(VITE_CONFIG)
    expect(config).toContain("const TEST_TRANSPORT = testTransportEnabled()")
    expect(config).toContain("__BEADBOX_TEST_TRANSPORT__: JSON.stringify(TEST_TRANSPORT)")
    expect(config).toContain("testTransportGuard(TEST_TRANSPORT)")
    const assigners = scanned
      .filter((f) => /__BEADBOX_TEST_TRANSPORT__\s*=[^=]/.test(read(f)))
      .map(rel)
    expect(assigners).toEqual([])
  })
})

describe("no release path turns the flag on", () => {
  const workflows = files(WORKFLOWS, (n) => /\.ya?ml$/.test(n))
  // A workflow that builds, signs or publishes the app, or calls one that does.
  const RELEASE =
    /tauri build|tauri:build|tauri-apps\/tauri-action|notarytool|notarize|codesign|gh release|action-gh-release/
  const releaseWorkflows = (() => {
    const direct = new Set(workflows.filter((f) => RELEASE.test(read(f))))
    let grew = true
    while (grew) {
      grew = false
      for (const f of workflows) {
        if (direct.has(f)) continue
        const callsRelease = [...direct].some((r) =>
          read(f).includes(`./.github/workflows/${r.split("/").pop()}`),
        )
        if (callsRelease) {
          direct.add(f)
          grew = true
        }
      }
    }
    return [...direct]
  })()

  test("finds the release workflows (guards against an empty classification)", () => {
    const names = releaseWorkflows.map((f) => f.split("/").pop())
    expect(names).toContain("release.yml")
    expect(names).toContain("build-arm-dmg.yml")
  })

  test("no release workflow mentions the flag", () => {
    expect(releaseWorkflows.filter((f) => read(f).includes(FLAG_ENV)).map(rel)).toEqual([])
  })

  test("no package `build` script, and nothing in the Tauri config, sets it", () => {
    const manifests = [
      join(REPO, "package.json"),
      ...files(join(REPO, "packages"), (n) => n === "package.json"),
    ]
    for (const manifest of manifests) {
      const scripts = (JSON.parse(read(manifest)).scripts ?? {}) as Record<string, string>
      for (const [name, command] of Object.entries(scripts)) {
        if (!command.includes(FLAG_ENV)) continue
        expect({ manifest: rel(manifest), name }).toEqual({
          manifest: rel(manifest),
          name: expect.stringMatching(/test|e2e/),
        })
        expect(name).not.toMatch(/^build/)
      }
    }
    for (const tauriConfig of files(join(REPO, "src-tauri"), (n) =>
      /^tauri.*\.conf\.json$/.test(n),
    )) {
      expect(read(tauriConfig)).not.toContain(FLAG_ENV)
    }
  })
})

describe("the test transport cannot listen or reach the network", () => {
  const source = read(MODULE)
  const BANNED: Array<[string, RegExp]> = [
    ["fetch(", /\bfetch\s*\(/],
    ["WebSocket(", /\bWebSocket\s*\(/],
    ["EventSource(", /\bEventSource\s*\(/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["navigator.sendBeacon", /\bsendBeacon\s*\(/],
    ["Bun.serve()", /\bBun\s*\.\s*serve\s*\(/],
    ["createServer()", /\bcreateServer\s*\(/],
    ["server.listen()", /\.listen\s*\(\s*(?:\d|[a-zA-Z_$])/],
    ["WebSocketServer", /\bnew\s+WebSocketServer\b|\bWebSocket\s*\.\s*Server\b/],
  ]
  for (const [description, pattern] of BANNED) {
    test(`no ${description}`, () => {
      expect(pattern.test(source)).toBe(false)
    })
  }

  test("its only runtime imports are kkrpc's browser channel (types aside)", () => {
    const runtimeImports = [
      ...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/gm),
    ].map((m) => m[1])
    const dynamicImports = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1],
    )
    expect(runtimeImports).toEqual([])
    expect(dynamicImports).toEqual(["kkrpc/browser"])
  })
})
