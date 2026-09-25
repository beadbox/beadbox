// lib/serve-http.ts against a fake bd serve (a throwaway Bun server inside
// __tests__; shipped source still listens nowhere). The rule under test: a
// response the client cannot trust or cannot complete is an ERROR of a known
// class, never an empty or partial result.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyServeFailure, ServeClient, ServeHttpError } from "../lib/serve-http"

let root: string
let beadsDir: string
let server: ReturnType<typeof Bun.serve>
let routes: Record<string, () => Response>
let hits: Record<string, number>
const TOKEN = "t0k"

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const row = (id: string) => ({ id, title: `t ${id}`, status: "open", priority: 2, issue_type: "task" })
const context = () => ({
  api_version: "v0",
  bd_version: "1.3.0",
  backend: "dolt",
  database: "demo",
  beads_dir: beadsDir,
  project_id: "p1",
  capabilities: ["issues.list", "issues.get", "config.get"],
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "beadbox-serve-http-"))
  beadsDir = join(root, ".beads")
  mkdirSync(beadsDir)
  hits = {}
  routes = {
    "/v0/beads/ready": () => json({ items: [] }),
    "/v0/beads/context": () => json(context()),
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      hits[url.pathname] = (hits[url.pathname] ?? 0) + 1
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ code: "unauthorized" }, 401)
      if (req.method !== "GET") return json({}, 405)
      const key = url.pathname.startsWith("/v0/beads/issues/") ? "/v0/beads/issues/:id" : url.pathname
      return (routes[`${key}?${url.searchParams.get("cursor") ?? ""}`] ?? routes[key] ?? (() => json({}, 404)))()
    },
  })
})

afterEach(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

const endpoint = () => ({ url: `http://127.0.0.1:${server.port}`, token: TOKEN })
const connect = () => ServeClient.connect(endpoint(), { beadsDir })

async function kind(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "resolved"
  } catch (e) {
    return e instanceof ServeHttpError ? e.kind : `other: ${String(e)}`
  }
}

describe("handshake: the server must prove it is this workspace", () => {
  test("a matching context connects", async () => {
    expect(await kind(connect())).toBe("resolved")
  })
  test("missing or different identity fields are an identity failure, not a match", async () => {
    for (const patch of [{ beads_dir: undefined }, { beads_dir: join(root, "other") }, { database: "" }, { backend: "sqlite" }]) {
      routes["/v0/beads/context"] = () => json({ ...context(), ...patch })
      expect(await kind(connect())).toBe("identity")
    }
  })
  test("an old or unknown API is a contract failure", async () => {
    for (const patch of [{ api_version: "v1" }, { bd_version: "1.2.2" }, { bd_version: "1.3.0-rc.2" }, { capabilities: "all" }]) {
      routes["/v0/beads/context"] = () => json({ ...context(), ...patch })
      expect(await kind(connect())).toBe("contract")
    }
  })
  test("a wrong token is an auth failure", async () => {
    expect(await kind(ServeClient.connect({ ...endpoint(), token: "nope" }, { beadsDir }))).toBe("auth")
  })
})

describe("reads", () => {
  test("the list follows pagination to the end", async () => {
    routes["/v0/beads/issues?"] = () => json({ items: [row("a"), row("b")], has_more: true, next_cursor: "c2" })
    routes["/v0/beads/issues?c2"] = () => json({ items: [row("c")], has_more: false })
    const c = await connect()
    expect((await c.listIssues()).map((i) => i.id)).toEqual(["a", "b", "c"])
  })
  test("one malformed row fails the whole list (never a partial list)", async () => {
    routes["/v0/beads/issues"] = () => json({ items: [row("a"), { id: "b", title: "no status" }], has_more: false })
    expect(await kind((await connect()).listIssues())).toBe("contract")
  })
  test("a detail with its counts missing is incomplete, not empty", async () => {
    const detail = { ...row("a"), comments: [], dependencies: null, dependents: null }
    routes["/v0/beads/issues/:id"] = () => json(detail)
    expect(await kind((await connect()).getIssueDetail("a"))).toBe("incomplete")
  })
  test("comments omitted while the count says there are some is incomplete", async () => {
    routes["/v0/beads/issues/:id"] = () =>
      json({ ...row("a"), comment_count: 3, dependent_count: 0, dependency_count: 0 })
    expect(await kind((await connect()).getIssueDetail("a"))).toBe("incomplete")
  })
  test("a complete detail is returned as sent", async () => {
    routes["/v0/beads/issues/:id"] = () =>
      json({
        ...row("a"),
        comment_count: 1,
        dependent_count: 0,
        dependency_count: 1,
        comments: [{ id: "c1", author: "x", text: "hi" }],
        dependencies: [{ id: "b" }],
        dependents: null,
      })
    const d = await (await connect()).getIssueDetail("a")
    expect(d.comments?.length).toBe(1)
    expect(d.dependencies?.[0]?.id).toBe("b")
  })
  test("only allowlisted config keys can be read", async () => {
    routes["/v0/beads/config/status.custom"] = () => json({ key: "status.custom", redacted: false, value: "a,b" })
    const c = await connect()
    expect(await c.getConfig("status.custom")).toBe("a,b")
    expect(await kind(c.getConfig("dolt.remote"))).toBe("contract")
  })
  test("an unsafe bead id never reaches the wire", async () => {
    const c = await connect()
    expect(await kind(c.getIssueDetail("--db=/tmp/evil"))).not.toBe("resolved")
    expect(hits["/v0/beads/issues/--db=/tmp/evil"]).toBeUndefined()
  })
})

describe("transient failures", () => {
  test("a 503 is retried once, then reported as unavailable", async () => {
    const c = await connect()
    routes["/v0/beads/issues"] = () => json({}, 503, { "Retry-After": "0" })
    expect(await kind(c.listIssues())).toBe("unavailable")
    expect(hits["/v0/beads/issues"]).toBe(2)
  })
  test("a 503 asking for a long wait is not retried", async () => {
    const c = await connect()
    routes["/v0/beads/issues"] = () => json({}, 503, { "Retry-After": "5" })
    expect(await kind(c.listIssues())).toBe("unavailable")
    expect(hits["/v0/beads/issues"]).toBe(1)
  })
  test("a redirect is refused, never followed (it could carry the token elsewhere)", async () => {
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => json({ items: [row("x")], has_more: false }) })
    try {
      const c = await connect()
      routes["/v0/beads/issues"] = () =>
        new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${other.port}/v0/beads/issues` } })
      expect(await kind(c.listIssues())).toBe("transport")
    } finally {
      other.stop(true)
    }
  })
  test("a dead server is a transport failure", async () => {
    const c = await connect()
    server.stop(true)
    expect(await kind(c.listIssues())).toBe("transport")
  })
})

test("failure classes: transient, integrity, incomplete (never 'empty')", () => {
  const cls = (k: ConstructorParameters<typeof ServeHttpError>[0]) => classifyServeFailure(new ServeHttpError(k, "x"))
  expect([cls("transport"), cls("unavailable"), cls("http")]).toEqual(["transient", "transient", "transient"])
  expect([cls("auth"), cls("identity"), cls("contract")]).toEqual(["integrity", "integrity", "integrity"])
  expect(cls("incomplete")).toBe("incomplete")
  expect(classifyServeFailure(new Error("unknown"))).toBe("transient")
})
