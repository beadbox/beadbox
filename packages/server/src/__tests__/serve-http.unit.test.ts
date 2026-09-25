import { describe, expect, test } from "bun:test"
import { ServeHttpSession, requestServeJson, type ServeHandle } from "../lib/serve-http"
import type { WorkspaceTarget } from "../lib/workspace-resolver"

const target: WorkspaceTarget = {
  id: "workspace-a", generation: 1, mode: "server", localBeadsDir: "/tmp/a/.beads",
  cliDbPath: "/tmp/a/.beads/beads.db", serverConnection: {
    host: "127.0.0.1", port: 3306, database: "beads_a", user: "root", tls: false,
  }, credentialKey: null, storageIdentity: "sql-a",
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    api_version: "v0", bd_version: "1.3.0", schema_version: 1, backend: "dolt", dolt_mode: "server",
    database: "beads_a", beads_dir: "/tmp/a/.beads", repo_root: "/tmp/a", project_id: "project-a",
    capabilities: ["project.enforce", "issues.list", "issues.get"], ...overrides,
  }
}

function handle(responses: Record<string, unknown>, calls: Array<[string, RequestInit | undefined]>): ServeHandle {
  return {
    address: "http://127.0.0.1:1234", token: "secret", target,
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      calls.push([path, init])
      if (!(path in responses)) throw new Error(`unexpected ${path}`)
      return responses[path] as T
    },
  }
}

describe("ServeHttpSession", () => {
  test("handshakes, stamps project and uses one unlimited list page", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const session = await ServeHttpSession.connect(handle({
      "/v0/beads/context": context(),
      "/v0/beads/ready?limit=1": { items: [] },
      "/v0/beads/issues?sort=priority&all=true&limit=0": { items: [{ id: "a" }], has_more: false },
      "/v0/beads/issues/a?include_comments=true&include_dependents=true&brief_deps=true": { id: "a", comments: [{ text: "ok" }] },
    }, calls))
    expect(session.hasCapability("issues.list")).toBe(true)
    expect(await session.listIssues({ all: true, limit: 0 })).toEqual([{ id: "a" }])
    expect(await session.getIssue("a", { includeComments: true, includeDependents: true, briefDeps: true })).toEqual({
      id: "a", comments: [{ text: "ok" }],
    })
    expect(calls[2]?.[1]?.headers).toEqual({ "Bd-Project-Id": "project-a" })
  })

  test("rejects wrong database before readiness", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    expect(ServeHttpSession.connect(handle({ "/v0/beads/context": context({ database: "other" }) }, calls)))
      .rejects.toMatchObject({ kind: "identity" })
  })

  test("rejects old server and missing capabilities", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    expect(ServeHttpSession.connect(handle({ "/v0/beads/context": context({ bd_version: "1.2.9" }) }, calls)))
      .rejects.toMatchObject({ kind: "contract" })
    expect(ServeHttpSession.connect(handle({ "/v0/beads/context": context({ capabilities: null }) }, calls)))
      .rejects.toMatchObject({ kind: "contract" })
  })

  test("list follows cursor with unchanged filters", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const session = await ServeHttpSession.connect(handle({
      "/v0/beads/context": context(), "/v0/beads/ready?limit=1": {},
      "/v0/beads/issues?sort=priority&all=true&limit=1": { items: [{ id: "a" }], has_more: true, next_cursor: "opaque" },
      "/v0/beads/issues?sort=priority&all=true&limit=1&cursor=opaque": { items: [{ id: "b" }], has_more: false },
    }, calls))
    expect(await session.listIssues({ all: true, limit: 1 })).toEqual([{ id: "a" }, { id: "b" }])
  })

  test("system list forwards all three category flags in priority order", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const path = "/v0/beads/issues?sort=priority&all=true&limit=0&include_gates=true&include_infra=true&include_templates=true"
    const session = await ServeHttpSession.connect(handle({
      "/v0/beads/context": context(), "/v0/beads/ready?limit=1": {},
      [path]: { items: [{ id: "a" }], has_more: false },
    }, calls))
    expect(await session.listIssues({
      all: true, limit: 0, include_gates: true, include_infra: true, include_templates: true,
    })).toEqual([{ id: "a" }])
    expect(calls.at(-1)?.[0]).toBe(path)
  })

  test("full detail carries both dependency directions and comments in one read", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const path = "/v0/beads/issues/a?include_comments=true&include_dependents=true&brief_deps=true"
    const detail = {
      id: "a", title: "Issue", status: "open", issue_type: "task", priority: 2,
      comment_count: 1, dependent_count: 1, comments_omitted: false,
      comments: [{ id: "c", author: "a", text: "hello", created_at: "2026-09-25T00:00:00Z" }],
      dependencies: [{ id: "b", title: "Blocker", status: "open", dependency_type: "blocks" }],
      dependents: [{ id: "c", title: "Blocked", status: "open", dependency_type: "blocks" }],
    }
    const session = await ServeHttpSession.connect(handle({
      "/v0/beads/context": context(), "/v0/beads/ready?limit=1": {}, [path]: detail,
    }, calls))
    expect(await session.getFullIssue("a")).toEqual(detail)
    expect(calls.map(([called]) => called)).toEqual(["/v0/beads/context", "/v0/beads/ready?limit=1", path])
  })

  test("full detail rejects omitted or malformed requested data", async () => {
    const path = "/v0/beads/issues/a?include_comments=true&include_dependents=true&brief_deps=true"
    for (const invalid of [
      { comments_omitted: true },
      { comment_count: 1, comments: null },
      { dependent_count: 1, dependents: null },
      { dependency_count: 1 },
      { dependencies: [{ id: "b", title: "Blocker", status: "open" }] },
    ]) {
      const session = await ServeHttpSession.connect(handle({
        "/v0/beads/context": context(), "/v0/beads/ready?limit=1": {},
        [path]: { id: "a", title: "Issue", status: "open", issue_type: "task", priority: 2, ...invalid },
      }, []))
      await expect(session.getFullIssue("a")).rejects.toMatchObject({ kind: "contract" })
    }
  })

  test("config get distinguishes absent value from redaction", async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const key = "/v0/beads/config/status.custom"
    const session = await ServeHttpSession.connect(handle({
      "/v0/beads/context": context({ capabilities: ["project.enforce", "config.get"] }),
      "/v0/beads/ready?limit=1": {}, [key]: { key: "status.custom", redacted: false },
    }, calls))
    expect(await session.getSetting("status.custom")).toBeNull()
    expect(calls.at(-1)?.[0]).toBe(key)
    const explicitNull = await ServeHttpSession.connect(handle({
      "/v0/beads/context": context({ capabilities: ["config.get"] }),
      "/v0/beads/ready?limit=1": {}, [key]: { key: "status.custom", value: null, redacted: false },
    }, []))
    expect(await explicitNull.getSetting("status.custom")).toBeNull()
    const redacted = await ServeHttpSession.connect(handle({
      "/v0/beads/context": context({ capabilities: ["config.get"] }),
      "/v0/beads/ready?limit=1": {}, [key]: { key: "status.custom", redacted: true },
    }, []))
    await expect(redacted.getSetting("status.custom")).rejects.toMatchObject({ kind: "contract" })
  })
})

test("problem JSON is parsed without exposing detail", async () => {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: () => new Response(JSON.stringify({ code: "invalid_argument", reason: "project_mismatch", request_id: "r1", detail: "secret" }), {
      status: 400, headers: { "Content-Type": "application/problem+json", "Retry-After": "2" },
    }),
  })
  try {
    await expect(requestServeJson(`http://127.0.0.1:${server.port}`, "token", "/v0/beads/issues"))
      .rejects.toMatchObject({ kind: "identity", status: 400, code: "invalid_argument", reason: "project_mismatch", requestId: "r1", retryAfter: 2 })
  } finally { server.stop(true) }
})
