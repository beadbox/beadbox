import { afterEach, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetPathCaches } from "../lib/bd-paths"
import { resolveServeBinary, ServeManager } from "../lib/serve-manager"
import { resolveWorkspaceTarget } from "../lib/workspace-resolver"

const dirs: string[] = []
afterEach(async () => {
  delete process.env.BD_PATH
  delete process.env.BEADBOX_SERVE_TEST_MARKER
  delete process.env.BEADBOX_REGISTRY_PATH
  resetPathCaches()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("npm bd shim resolves to its native child for owned serve lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beadbox-serve-binary-test-"))
  dirs.push(dir)
  const shim = join(dir, "bd.js")
  const native = join(dir, process.platform === "win32" ? "bd.exe" : "bd")
  await writeFile(shim, "#!/usr/bin/env node\n")
  await writeFile(native, "native")
  expect(resolveServeBinary(shim)).toBe(realpathSync(native))
  await rm(native)
  expect(() => resolveServeBinary(shim)).toThrow("bd native executable unavailable")
})

test("concurrent first reads share an owned child and stop sends TERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beadbox-manager-test-"))
  dirs.push(dir)
  const beadsDir = join(dir, ".beads")
  await mkdir(beadsDir)
  await writeFile(join(beadsDir, "metadata.json"), JSON.stringify({ dolt_mode: "server" }))
  const marker = join(dir, "starts")
  const executable = join(dir, "fake-bd")
  await writeFile(
    executable,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs"
const args = process.argv.slice(2)
if (args.includes("--version")) { console.log("bd version 1.3.0"); process.exit(0) }
appendFileSync(process.env.BEADBOX_SERVE_TEST_MARKER, JSON.stringify(args) + "\\n")
const token = readFileSync(args[args.indexOf("--auth-token-file") + 1], "utf8").trim()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (request.headers.get("Authorization") !== "Bearer " + token) return new Response("{}", { status: 401 })
  const path = new URL(request.url).pathname
  if (path === "/v0/beads/context") return Response.json({
    api_version: "v0", bd_version: "1.3.0", schema_version: 1,
    backend: "dolt", dolt_mode: "server", database: "beads_a", project_id: "p",
    beads_dir: ${JSON.stringify(beadsDir)}, repo_root: ${JSON.stringify(dir)},
    capabilities: ["issues.list", "issues.get", "project.enforce"]
  })
  if (path === "/v0/beads/ready") return Response.json({items: []})
  if (path === "/v0/beads/issues") return Response.json({items: [], has_more: false})
  return new Response("{}", { status: 404 })
}})
console.log("bd serve: listening on http://127.0.0.1:" + server.port)
console.error("event=request_error request_id=test-503 error=connection reset by peer")
process.on("SIGTERM", () => { appendFileSync(process.env.BEADBOX_SERVE_TEST_MARKER, "TERM\\n"); server.stop(true); process.exit(0) })
`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = executable
  process.env.BEADBOX_SERVE_TEST_MARKER = marker
  process.env.BEADBOX_REGISTRY_PATH = join(dir, "registry.json")
  await writeFile(join(dir, "config.json"), JSON.stringify({ bdServeStderrLog: true }))
  await writeFile(
    process.env.BEADBOX_REGISTRY_PATH,
    JSON.stringify({
      version: 2,
      activeWorkspace: null,
      workspaces: [
        {
          id: "a",
          name: "test",
          addedAt: new Date().toISOString(),
          local: { path: beadsDir },
          server: { host: "127.0.0.1", port: 3306, database: "beads_a", user: "root", tls: false },
          mode: "server",
          serverOwnership: "external",
        },
      ],
    }),
  )
  resetPathCaches()
  const target = await resolveWorkspaceTarget("a")
  const logDirectory = join(dir, "logs")
  const manager = new ServeManager(logDirectory)
  try {
    expect(manager.hasReadySession(target)).toBe(false)
    const [a, b] = await Promise.all([manager.getSession(target), manager.getSession(target)])
    expect(a).toBe(b)
    expect(manager.hasReadySession(target)).toBe(true)
    expect(await a.listIssues({ all: true, limit: 0 })).toEqual([])
    const starts = (await readFile(marker, "utf8")).trim().split("\n")
    expect(starts).toHaveLength(1)
    const argv = starts[0] ?? ""
    expect(argv).toContain("--auth-token-file")
    const args = JSON.parse(argv) as string[]
    const tokenFile = args[args.indexOf("--auth-token-file") + 1]!
    const token = (await readFile(tokenFile, "utf8")).trim()
    expect(argv).not.toContain(token)
    await manager.stopAll()
    expect((await readFile(marker, "utf8")).trim().split("\n")).toContain("TERM")
    expect(
      await readFile(join(logDirectory, `bd-serve-stderr-${process.pid}-a.log`), "utf8"),
    ).toContain("request_id=test-503")
    await expect(manager.getSession(target)).rejects.toMatchObject({ kind: "startup" })
  } finally {
    await manager.stopAll()
  }
})
