// A fake `bd serve` for serve-reads tests (beadbox-6x2 L4). Started as
//   bun fake-serve.ts serve --addr 127.0.0.1:0 --auth-token-file <file>
// from the workspace directory. It serves rows titled "from-serve" so a test
// can tell which path answered, writes its pid to ./fake-serve.pid, and reads
// ./fake-serve-mode on EVERY request so a test can change its behaviour:
//   normal | slow-start (read at startup) | garbage | identity | 503 | incomplete
// Unknown or missing mode = normal.

import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const tokenFile = args[args.indexOf("--auth-token-file") + 1]
const token = readFileSync(tokenFile, "utf-8").trim()
const cwd = process.cwd()
const mode = () => {
  try {
    return readFileSync(join(cwd, "fake-serve-mode"), "utf-8").trim()
  } catch {
    return "normal"
  }
}

const row = (id: string) => ({ id, title: `from-serve ${id}`, status: "open", priority: 2, issue_type: "task" })
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof b === "string" ? b : JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } })

if (mode() === "slow-start") await Bun.sleep(1500)
writeFileSync(join(cwd, "fake-serve.pid"), String(process.pid))

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${token}`) return json({}, 401)
    const url = new URL(req.url)
    const m = mode()
    if (url.pathname === "/v0/beads/ready") return json({ items: [] })
    if (url.pathname === "/v0/beads/context") {
      return json({
        api_version: "v0",
        bd_version: "1.3.0",
        backend: "dolt",
        database: "fake",
        beads_dir: m === "identity" ? "/somewhere/else/.beads" : realpathSync(join(cwd, ".beads")),
        project_id: "p",
        capabilities: ["issues.list", "issues.get", "config.get"],
      })
    }
    if (m === "garbage") return json("not json at all")
    if (m === "503") return json({}, 503, { "Retry-After": "0" })
    if (url.pathname === "/v0/beads/issues") return json({ items: [row("w-1"), row("w-2")], has_more: false })
    if (url.pathname.startsWith("/v0/beads/issues/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "")
      const base = { ...row(id), comments: [{ id: "c1", issue_id: id, author: "a", text: "serve comment", created_at: "2026-01-01T00:00:00Z" }], dependencies: null, dependents: null }
      return json(m === "incomplete" ? base : { ...base, comment_count: 1, dependent_count: 0, dependency_count: 0 })
    }
    if (url.pathname === "/v0/beads/config/status.custom") return json({ key: "status.custom", redacted: false, value: "serve-a,serve-b" })
    return json({}, 404)
  },
})
process.stdout.write(`bd serve: listening on http://127.0.0.1:${server.port}\n`)
