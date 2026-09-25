// HTTP client for a bd serve child (beadbox-6x2, landing L3), based on the
// client contributed in PR #49. Read-only, and deliberately small:
//
//  - ONE fetch call, GET only, to a URL built by serveUrl() from the address
//    ServeManager parsed from its own child's listening line (sec C5), over a
//    fixed set of paths (sec C4, pinned by serve-http-census.security.test).
//  - Everything that comes back is data, validated before use: the context
//    must name OUR workspace (identity fields REQUIRED; a missing field is a
//    mismatch), and rows must have the shape the CLI path's types assume.
//  - Failures are classified so the caller never turns one into an empty
//    result: transient -> read via the CLI now, retry serve later;
//    integrity -> read via the CLI and stop using serve for this workspace;
//    incomplete -> this one read via the CLI.
//
// Nothing routes reads here yet (L4).

import { realpathSync } from "node:fs"
import { assertSafeBeadId } from "./bd-argv"
import { SERVE_MIN_BD_VERSION } from "./version-requirements"

export type ServeErrorKind =
  | "transport" // connection failed or timed out
  | "unavailable" // HTTP 503 (bd: db_unavailable)
  | "http" // any other non-2xx
  | "auth" // 401 / 403
  | "identity" // the server is not this workspace
  | "contract" // API version, capability or response shape
  | "incomplete" // a detail omitted data it was asked for

export class ServeHttpError extends Error {
  constructor(
    public readonly kind: ServeErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = "ServeHttpError"
  }
}

export type ServeFailureClass = "transient" | "integrity" | "incomplete"

/** How a read should react to a serve failure. Never "empty". */
export function classifyServeFailure(error: unknown): ServeFailureClass {
  if (!(error instanceof ServeHttpError)) return "transient"
  switch (error.kind) {
    case "auth":
    case "identity":
    case "contract":
      return "integrity"
    case "incomplete":
      return "incomplete"
    default:
      return "transient"
  }
}

type JsonObject = Record<string, unknown>
export type Issue = JsonObject & { id: string; title: string; status: string; priority: number; issue_type: string }
export type IssueDetails = Issue & { comments?: JsonObject[] | null; dependencies?: JsonObject[] | null; dependents?: JsonObject[] | null }

/** What the client needs from ServeManager's handle. */
export interface ServeEndpoint {
  url: string
  token: string
}

/** The workspace this child must be serving. */
export interface ServeIdentity {
  beadsDir: string
}

const LOOPBACK_BASE = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/
const ALLOWED_CONFIG_KEYS = new Set(["status.custom"])
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RETRY_WAIT_MS = 1_500

/**
 * The ONLY URL builder (C5). The base must be the loopback address parsed
 * from our own child's listening line; the path must be one of ours.
 */
export function serveUrl(endpoint: ServeEndpoint, path: string): string {
  const m = LOOPBACK_BASE.exec(endpoint.url)
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 65535) throw new ServeHttpError("contract", "bd serve: not a loopback address")
  if (!path.startsWith("/v0/beads/")) throw new ServeHttpError("contract", "bd serve: path outside the read API")
  return `${endpoint.url}${path}`
}

const object = (v: unknown): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v)

function canonical(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function atLeastMinVersion(v: string): boolean {
  const m = /(?:^|[\s v])(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?=$|[\s(])/.exec(v.trim())
  const min = /^(\d+)\.(\d+)\.(\d+)$/.exec(SERVE_MIN_BD_VERSION)
  if (!m || !min) return false
  for (let i = 1; i <= 3; i++) {
    if (Number(m[i]) !== Number(min[i])) return Number(m[i]) > Number(min[i])
  }
  return m[4] === undefined
}

/** Context and identity, all REQUIRED (a missing field is a mismatch). */
function validateContext(ctx: unknown, expected: ServeIdentity): { capabilities: Set<string>; projectId: string } {
  if (!object(ctx)) throw new ServeHttpError("contract", "bd serve: invalid context")
  if (ctx.api_version !== "v0" || typeof ctx.bd_version !== "string" || !atLeastMinVersion(ctx.bd_version)) {
    throw new ServeHttpError("contract", "bd serve: unsupported API or bd version")
  }
  if (!Array.isArray(ctx.capabilities) || !ctx.capabilities.every((c) => typeof c === "string")) {
    throw new ServeHttpError("contract", "bd serve: invalid capabilities")
  }
  if (ctx.backend !== "dolt" || typeof ctx.database !== "string" || !ctx.database) {
    throw new ServeHttpError("identity", "bd serve: backend or database missing")
  }
  const theirs = typeof ctx.beads_dir === "string" ? canonical(ctx.beads_dir) : null
  const ours = canonical(expected.beadsDir)
  if (!theirs || !ours || theirs !== ours) throw new ServeHttpError("identity", "bd serve: not this workspace")
  return {
    capabilities: new Set(ctx.capabilities as string[]),
    projectId: typeof ctx.project_id === "string" ? ctx.project_id : "",
  }
}

function validRow(v: unknown): v is Issue {
  return (
    object(v) &&
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.status === "string" &&
    typeof v.priority === "number" &&
    typeof v.issue_type === "string"
  )
}

function validateDetailShape(d: unknown, id: string): IssueDetails {
  if (!validRow(d) || d.id !== id) throw new ServeHttpError("contract", "bd serve: invalid issue detail")
  for (const field of ["comments", "dependencies", "dependents"] as const) {
    const v = d[field]
    if (v !== undefined && v !== null && !Array.isArray(v)) throw new ServeHttpError("contract", `bd serve: invalid ${field}`)
  }
  const commentOk = (c: unknown) =>
    object(c) && typeof c.id === "string" && typeof c.author === "string" && typeof c.text === "string"
  if (!((d.comments ?? []) as unknown[]).every(commentOk)) throw new ServeHttpError("contract", "bd serve: invalid comments")
  for (const field of ["dependencies", "dependents"] as const) {
    const ok = ((d[field] ?? []) as unknown[]).every((n) => object(n) && typeof n.id === "string")
    if (!ok) throw new ServeHttpError("contract", `bd serve: invalid ${field}`)
  }
  return d as IssueDetails
}

// Presence. A count we cannot check is not "zero": the caller reads via the CLI.
function validateDetailPresence(d: IssueDetails): void {
  if (typeof d.comment_count !== "number" || typeof d.dependent_count !== "number") {
    throw new ServeHttpError("incomplete", "bd serve: detail counts missing")
  }
  if (d.comments_omitted === true || (d.comment_count > 0 && !Array.isArray(d.comments))) {
    throw new ServeHttpError("incomplete", "bd serve: comments omitted")
  }
  if (d.dependent_count > 0 && !Array.isArray(d.dependents)) throw new ServeHttpError("incomplete", "bd serve: dependents omitted")
  // An explicit null is an empty hydrated list (dangling external edges can
  // still count); an absent field with a positive count is truncation.
  if (typeof d.dependency_count === "number" && d.dependency_count > 0 && d.dependencies === undefined) {
    throw new ServeHttpError("incomplete", "bd serve: dependencies omitted")
  }
}

function validateDetail(d: unknown, id: string): IssueDetails {
  const detail = validateDetailShape(d, id)
  validateDetailPresence(detail)
  return detail
}

export class ServeClient {
  private constructor(
    private readonly endpoint: ServeEndpoint,
    private readonly capabilities: Set<string>,
    private readonly projectId: string,
  ) {}

  /** Ready check, then the identity handshake. Throws unless this child serves `expected`. */
  static async connect(endpoint: ServeEndpoint, expected: ServeIdentity): Promise<ServeClient> {
    await getJson(endpoint, "/v0/beads/ready?limit=1", {})
    const { capabilities, projectId } = validateContext(await getJson(endpoint, "/v0/beads/context", {}), expected)
    return new ServeClient(endpoint, capabilities, projectId)
  }

  private get(path: string): Promise<unknown> {
    const headers: Record<string, string> = {}
    if (this.capabilities.has("project.enforce") && this.projectId) headers["Bd-Project-Id"] = this.projectId
    return getJson(this.endpoint, path, headers)
  }

  private requireCapability(capability: string): void {
    if (!this.capabilities.has(capability)) throw new ServeHttpError("contract", `bd serve lacks ${capability}`)
  }

  /** The whole list, as `bd list --status all --limit 0 --flat` returns it. */
  async listIssues(): Promise<Issue[]> {
    this.requireCapability("issues.list")
    const params = new URLSearchParams({ sort: "priority", all: "true", limit: "0" })
    const items: Issue[] = []
    for (let page = 0; page < 10_000; page++) {
      const body = await this.get(`/v0/beads/issues?${params}`)
      if (!object(body) || !Array.isArray(body.items) || typeof body.has_more !== "boolean") {
        throw new ServeHttpError("contract", "bd serve: invalid issues page")
      }
      if (!body.items.every(validRow)) throw new ServeHttpError("contract", "bd serve: malformed issue row")
      items.push(...(body.items as Issue[]))
      if (!body.has_more) return items
      if (typeof body.next_cursor !== "string" || !body.next_cursor) {
        throw new ServeHttpError("contract", "bd serve: invalid pagination")
      }
      params.set("cursor", body.next_cursor)
    }
    throw new ServeHttpError("contract", "bd serve: pagination did not end")
  }

  /** Issue, comments and both dependency directions: the detail panel's data. */
  async getIssueDetail(id: string): Promise<IssueDetails> {
    this.requireCapability("issues.get")
    const safe = assertSafeBeadId(id)
    const body = await this.get(
      `/v0/beads/issues/${encodeURIComponent(safe)}?include_comments=true&include_dependents=true&brief_deps=true`,
    )
    return validateDetail(body, safe)
  }

  /** A config value by key, from a fixed allowlist. null = not set. */
  async getConfig(key: string): Promise<string | null> {
    if (!ALLOWED_CONFIG_KEYS.has(key)) throw new ServeHttpError("contract", "bd serve: config key not allowed")
    this.requireCapability("config.get")
    const body = await this.get(`/v0/beads/config/${encodeURIComponent(key)}`)
    if (
      !object(body) ||
      body.key !== key ||
      typeof body.redacted !== "boolean" ||
      (body.value !== undefined && body.value !== null && typeof body.value !== "string")
    ) {
      throw new ServeHttpError("contract", "bd serve: invalid setting")
    }
    if (body.redacted) throw new ServeHttpError("contract", "bd serve: setting redacted")
    return (body.value as string | null | undefined) ?? null
  }
}

/** The single fetch: GET, bearer, timeout, one bounded retry on transport or 503. */
async function getJson(endpoint: ServeEndpoint, path: string, extraHeaders: Record<string, string>): Promise<unknown> {
  const url = serveUrl(endpoint, path)
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { ...extraHeaders, Authorization: `Bearer ${endpoint.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // Never follow a redirect: it could carry the bearer to another address.
        redirect: "error",
      })
    } catch {
      if (attempt === 0) continue
      throw new ServeHttpError("transport", "bd serve: connection failed")
    }
    if (response.ok) {
      try {
        return await response.json()
      } catch {
        throw new ServeHttpError("contract", "bd serve: invalid JSON")
      }
    }
    await response.body?.cancel().catch(() => {})
    const status = response.status
    if (status === 401 || status === 403) throw new ServeHttpError("auth", `bd serve: HTTP ${status}`, status)
    if (status === 503) {
      const header = response.headers.get("Retry-After")
      const wait = header && /^\d+$/.test(header) ? Number(header) * 1000 : 200
      if (attempt === 0 && wait <= MAX_RETRY_WAIT_MS) {
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw new ServeHttpError("unavailable", "bd serve: HTTP 503", status, header ? Number(header) : undefined)
    }
    throw new ServeHttpError("http", `bd serve: HTTP ${status}`, status)
  }
}
