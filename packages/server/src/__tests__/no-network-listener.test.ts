// Architecture invariant: the shipped app opens no network listener at all
// (beadbox-l5i.3, item 1).
//
// The opensource checklist (§4) asks us to "verify the sidecar HTTP/WS server
// binds 127.0.0.1 only". That framing predates the current architecture: the
// Next.js custom server is gone and the sidecar speaks kkrpc over STDIO
// (packages/server/src/index.ts -> BunIo(Bun.stdin.stream()), reached from the
// client via tauri-plugin-js). There is no socket to bind, which is a stronger
// property than binding to loopback — but only for as long as it stays true.
//
// This test is that guarantee. If someone reintroduces an HTTP or WebSocket
// listener, the loopback-bind and Origin-validation questions come back with
// it, and this fails loudly at that moment rather than at the next audit.
//
// Outbound clients are unaffected: mysql2 connecting to Dolt on 127.0.0.1 is a
// client socket, not a listener.
//
// The opt-in serve-reads pilot (beadbox-6x2) does not change this ban: when a
// user enables it for a local server-mode workspace, the LISTENER belongs to
// bd serve, a child process the sidecar starts, authenticates to with a
// per-child token, and reaps with itself (lib/serve-manager.ts). Our code
// still listens nowhere, and every pattern below stays banned. The sidecar's
// side of that connection is pinned structurally, not by this file's
// literal-URL regex (which cannot see a URL built at runtime): see
// serve-http-census.security.test.ts (one GET-only fetch, in lib/serve-http.ts,
// to an address parsed from our own child).

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const PACKAGES_DIR = join(import.meta.dir, "..", "..", "..")
const SCANNED = [join(PACKAGES_DIR, "server", "src"), join(PACKAGES_DIR, "client", "src")]

// Each entry is [human-readable description, detector].
const LISTENER_PATTERNS: Array<[string, RegExp]> = [
  ["Bun.serve()", /\bBun\s*\.\s*serve\s*\(/],
  ["http/https/net/tls createServer()", /\bcreateServer\s*\(/],
  ["server.listen()", /\.listen\s*\(\s*(?:\d|[a-zA-Z_$])/],
  ["WebSocketServer", /\bnew\s+WebSocketServer\b|\bWebSocket\s*\.\s*Server\b/],
  ["Deno.serve()", /\bDeno\s*\.\s*serve\s*\(/],
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // Test files may legitimately stand up a throwaway server in a fixture.
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue
      out.push(...sourceFiles(full))
      continue
    }
    if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full)
  }
  return out
}

describe("no network listener in shipped source", () => {
  const files = SCANNED.flatMap(sourceFiles)

  test("finds source files to scan (guards against a silently empty sweep)", () => {
    expect(files.length).toBeGreaterThan(50)
  })

  for (const [description, pattern] of LISTENER_PATTERNS) {
    test(`no ${description}`, () => {
      const offenders = files
        .filter((f) => pattern.test(readFileSync(f, "utf-8")))
        .map((f) => relative(PACKAGES_DIR, f))
      expect(offenders).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// Outbound side of the same property (beadbox-l5i.3, item 6).
//
// lib/bd.ts used to fire-and-forget every bd invocation — subcommand, args and
// the workspace dbPath, i.e. real filesystem paths — at
// `http://localhost:${PORT ?? 3000}/internal/event`. That handler lived in the
// deleted Next.js custom server, so in a production build the POST went to
// whatever unrelated process happened to hold port 3000. Removed, and pinned
// here: the sidecar makes no plaintext-http request to a hard-coded URL. The
// single runtime-built one (to our own bd serve child) is pinned by
// serve-http-census.security.test.ts.
// ---------------------------------------------------------------------------

describe("no plaintext-http outbound calls in shipped source", () => {
  const files = SCANNED.flatMap(sourceFiles)

  test("no fetch() to an http:// or ws:// URL", () => {
    const offenders = files
      .filter((f) => /fetch\(\s*[`"'][^`"']*http:\/\//.test(readFileSync(f, "utf-8")))
      .map((f) => relative(PACKAGES_DIR, f))
    expect(offenders).toEqual([])
  })

  test("no /internal/event emitter remains", () => {
    const offenders = files
      .filter((f) => readFileSync(f, "utf-8").includes("/internal/event"))
      .map((f) => relative(PACKAGES_DIR, f))
    expect(offenders).toEqual([])
  })
})
