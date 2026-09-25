// sec's C3 (beadbox-6x2): demonstrated properties of the REAL bd serve that
// the pilot relies on. If any fails for a bd version, that version must not
// route reads (a version gate), not merely be noted.
//   (i)   a write route without the bearer is refused (401) and changes nothing
//   (ii)  a foreign Host header is refused, even with a valid bearer
//   (iii) no response grants cross-origin access (no Access-Control-Allow-Origin)
//
// Needs a real bd >= 1.3.0: set BEADBOX_TEST_BD_SERVE=/abs/path/to/bd. CI has
// none today, so without it this SKIPS, with that reason, and a skip is not a
// pass: the real-binary run is posted on the bead as evidence.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type ServeHandle, ServeManager } from "../lib/serve-manager"

// Workspace setup against a real bd (init, Dolt start, serve start) takes seconds.
setDefaultTimeout(120_000)

const BD = process.env.BEADBOX_TEST_BD_SERVE
const SKIP = !BD
if (SKIP) console.warn("[serve-contract] SKIPPED: set BEADBOX_TEST_BD_SERVE to a bd >= 1.3.0 to run sec's C3 checks")

let dir = ""
let manager: ServeManager | null = null
let serve: ServeHandle | null = null

const bd = (args: string[]) => execFileSync(BD as string, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString()
const count = () => JSON.parse(bd(["count", "--json"])).count as number

beforeAll(async () => {
  if (SKIP) return
  // bd serve refuses a workspace under a temp directory.
  const parent = process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache")
  mkdirSync(parent, { recursive: true })
  dir = mkdtempSync(join(parent, "beadbox-contract-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  bd(["init", "--server", "--prefix", "c", "--quiet", "--skip-agents", "--skip-hooks"])
  bd(["create", "first", "--json"])
  bd(["create", "second", "--json"])
  manager = new ServeManager({ bdPath: () => BD as string })
  serve = await manager.get({ key: "contract", workspaceDir: dir, env: {} })
})

afterAll(async () => {
  await manager?.stopAll()
  if (dir.includes("beadbox-contract-")) {
    try {
      const pid = Number(bd(["dolt", "status", "--json"]).match(/"pid":\s*(\d+)/)?.[1])
      if (pid) process.kill(pid, "SIGTERM")
    } catch {
      /* not running */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

const url = (p: string) => `${serve?.url}${p}`
const bearer = () => ({ Authorization: `Bearer ${serve?.token}` })

describe.skipIf(SKIP)("real bd serve: the properties the pilot relies on (C3)", () => {
  test("(i) write routes without the bearer are 401 and change nothing", async () => {
    const before = count()
    const id = JSON.parse(bd(["list", "--json"]))[0].id as string
    const writes: Array<[string, string, unknown]> = [
      ["POST", "/v0/beads/issues", { title: "evil" }],
      ["POST", "/v0/beads/issues:delete", { ids: [id] }],
      ["POST", "/v0/beads/issues:batchClose", { ids: [id] }],
      ["POST", "/v0/beads/issues:sweep", {}],
      ["PATCH", `/v0/beads/issues/${id}`, { title: "evil" }],
    ]
    for (const [method, path, body] of writes) {
      const r = await fetch(url(path), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      expect([method, path, r.status]).toEqual([method, path, 401])
    }
    expect(count()).toBe(before)
    expect(bd(["show", id, "--json"])).not.toContain('"evil"')
  })

  test("(ii) a foreign Host is refused, even with a valid bearer and even on /healthz", async () => {
    const ok = await fetch(url("/v0/beads/context"), { headers: bearer() })
    expect(ok.status).toBe(200) // precondition: the bearer works
    for (const path of ["/v0/beads/context", "/healthz"]) {
      const r = await fetch(url(path), { headers: { ...bearer(), Host: "evil.example" } })
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
    }
  })

  test("(iii) nothing grants cross-origin access", async () => {
    const origin = { Origin: "https://evil.example" }
    const responses = [
      await fetch(url("/v0/beads/context"), { headers: { ...bearer(), ...origin } }),
      await fetch(url("/healthz"), { headers: origin }),
      await fetch(url("/v0/beads/context"), {
        method: "OPTIONS",
        headers: { ...origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
      }),
    ]
    for (const r of responses) {
      expect(r.headers.get("access-control-allow-origin")).toBeNull()
      expect(r.headers.get("access-control-allow-credentials")).toBeNull()
    }
  })
})
