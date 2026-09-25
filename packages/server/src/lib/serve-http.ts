import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { WorkspaceTarget } from "./workspace-resolver"

export type ServeErrorKind = "startup" | "transport" | "identity" | "auth" | "contract" | "http"

/** Structured v0 failure. Callers decide if a read may use the CLI route. */
export class ServeHttpError extends Error {
  constructor(
    public readonly kind: ServeErrorKind,
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly reason?: string,
    public readonly requestId?: string,
    public readonly retryAfter?: number,
  ) {
    super(message)
    this.name = "ServeHttpError"
  }
}

type JsonObject = Record<string, unknown>
type ServeContext = JsonObject & { capabilities: string[]; project_id: string }
export type Issue = JsonObject & { id: string }
export type IssueDetails = Issue & {
  comments?: JsonObject[]
  dependencies?: JsonObject[]
  dependents?: JsonObject[]
}
type GetIssueOptions = {
  includeComments?: boolean
  includeDependents?: boolean
  briefDeps?: boolean
}
export type ListIssuesQuery = Record<
  string,
  string | number | boolean | readonly string[] | undefined
>

export interface ServeHandle {
  readonly address: string
  readonly token: string
  readonly target: WorkspaceTarget
  request<T>(path: string, init?: RequestInit): Promise<T>
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function versionAtLeast13(value: string): boolean {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/.exec(value)
  return !!match && (Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 3))
}

function samePath(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return true
  const canonical = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return canonical(actual) === canonical(expected)
}

function validateContext(context: unknown): ServeContext {
  if (!object(context)) throw new ServeHttpError("contract", "Invalid bd serve context")
  if (
    context.api_version !== "v0" ||
    typeof context.bd_version !== "string" ||
    !versionAtLeast13(context.bd_version)
  ) {
    throw new ServeHttpError("contract", "Unsupported bd serve API or version")
  }
  if (
    !Array.isArray(context.capabilities) ||
    !context.capabilities.every((v) => typeof v === "string") ||
    typeof context.project_id !== "string" ||
    typeof context.database !== "string"
  ) {
    throw new ServeHttpError("contract", "Incomplete bd serve context")
  }
  return context as ServeContext
}

function validateContextIdentity(context: JsonObject, target: WorkspaceTarget): void {
  const expectedDatabase = target.serverConnection?.database
  if (
    context.backend !== "dolt" ||
    context.dolt_mode !== "server" ||
    (expectedDatabase && context.database !== expectedDatabase) ||
    (target.localBeadsDir && !samePath(context.beads_dir, target.localBeadsDir))
  ) {
    throw new ServeHttpError("identity", "bd serve workspace identity mismatch")
  }
  // repo_root is optional on the wire; when present, it must contain the known .beads directory.
  if (
    target.localBeadsDir &&
    typeof context.repo_root === "string" &&
    !samePath(context.repo_root, resolve(target.localBeadsDir, ".."))
  ) {
    throw new ServeHttpError("identity", "bd serve repository identity mismatch")
  }
}

function issuesPage(value: unknown): { items: Issue[]; has_more: boolean; next_cursor?: string } {
  if (
    !object(value) ||
    !Array.isArray(value.items) ||
    typeof value.has_more !== "boolean" ||
    !value.items.every((item) => object(item) && typeof item.id === "string")
  ) {
    throw new ServeHttpError("contract", "Invalid bd serve issues page")
  }
  return value as { items: Issue[]; has_more: boolean; next_cursor?: string }
}

function validateFullIssueShape(detail: IssueDetails): void {
  for (const field of ["comments", "dependencies", "dependents"] as const) {
    const value = detail[field]
    if (value !== undefined && value !== null && !Array.isArray(value))
      throw new ServeHttpError("contract", `Invalid bd serve ${field}`)
  }
  if (
    typeof detail.title !== "string" ||
    typeof detail.status !== "string" ||
    typeof detail.issue_type !== "string" ||
    typeof detail.priority !== "number"
  )
    throw new ServeHttpError("contract", "Invalid bd serve issue fields")
  validateFullIssueComments(detail)
  validateFullIssueNeighbors(detail)
}

function validateFullIssueComments(detail: IssueDetails): void {
  if (
    !((detail.comments ?? []) as unknown[]).every(
      (comment) =>
        object(comment) &&
        typeof comment.id === "string" &&
        typeof comment.author === "string" &&
        typeof comment.text === "string" &&
        typeof comment.created_at === "string",
    )
  )
    throw new ServeHttpError("contract", "Invalid bd serve comments")
}

function validateFullIssueNeighbors(detail: IssueDetails): void {
  for (const field of ["dependencies", "dependents"] as const) {
    if (
      !((detail[field] ?? []) as unknown[]).every(
        (neighbor) =>
          object(neighbor) &&
          typeof neighbor.id === "string" &&
          typeof neighbor.title === "string" &&
          typeof neighbor.status === "string" &&
          typeof neighbor.dependency_type === "string",
      )
    )
      throw new ServeHttpError("contract", `Invalid bd serve ${field}`)
  }
}

function validateFullIssuePresence(detail: IssueDetails): void {
  if (detail.comments_omitted === true)
    throw new ServeHttpError("contract", "bd serve omitted requested comments")
  if (
    typeof detail.comment_count === "number" &&
    detail.comment_count > 0 &&
    !Array.isArray(detail.comments)
  )
    throw new ServeHttpError("contract", "bd serve omitted requested comments")
  if (
    typeof detail.dependent_count === "number" &&
    detail.dependent_count > 0 &&
    !Array.isArray(detail.dependents)
  )
    throw new ServeHttpError("contract", "bd serve omitted requested dependents")
  // An explicit null can represent an empty hydrated neighbor list even
  // when dangling external edges contribute to dependency_count. Omission
  // with a positive count is a truncated response instead.
  if (
    typeof detail.dependency_count === "number" &&
    detail.dependency_count > 0 &&
    detail.dependencies === undefined
  )
    throw new ServeHttpError("contract", "bd serve omitted dependencies")
}

export class ServeHttpSession {
  readonly capabilities: ReadonlySet<string>
  readonly projectId: string
  private constructor(
    private readonly handle: ServeHandle,
    capabilities: string[],
    projectId: string,
  ) {
    this.capabilities = new Set(capabilities)
    this.projectId = projectId
  }

  static async connect(handle: ServeHandle): Promise<ServeHttpSession> {
    const context = validateContext(await handle.request<unknown>("/v0/beads/context"))
    validateContextIdentity(context, handle.target)
    const session = new ServeHttpSession(handle, context.capabilities, context.project_id)
    await session.request("/v0/beads/ready?limit=1")
    return session
  }

  hasCapability(name: string): boolean {
    return this.capabilities.has(name)
  }

  private request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {}
    if (this.capabilities.has("project.enforce") && this.projectId)
      headers["Bd-Project-Id"] = this.projectId
    return this.handle.request<T>(path, { headers })
  }

  async listIssues(query: ListIssuesQuery = {}): Promise<Issue[]> {
    if (!this.hasCapability("issues.list"))
      throw new ServeHttpError("contract", "bd serve lacks issues.list")
    const params = new URLSearchParams()
    // `bd list` without --sort uses priority order in Beads 1.3.0.
    params.set("sort", typeof query.sort === "string" ? query.sort : "priority")
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || key === "sort") continue
      for (const part of Array.isArray(value) ? value : [value]) params.append(key, String(part))
    }
    const items: Issue[] = []
    for (;;) {
      const page = issuesPage(await this.request<unknown>(`/v0/beads/issues?${params}`))
      items.push(...page.items)
      if (!page.has_more) return items
      if (query.limit === 0 || typeof page.next_cursor !== "string" || !page.next_cursor) {
        throw new ServeHttpError("contract", "Invalid bd serve pagination")
      }
      params.set("cursor", page.next_cursor)
    }
  }

  async getIssue(id: string, options?: GetIssueOptions): Promise<IssueDetails> {
    if (!this.hasCapability("issues.get"))
      throw new ServeHttpError("contract", "bd serve lacks issues.get")
    const params = new URLSearchParams()
    if (options?.includeComments) params.set("include_comments", "true")
    if (options?.includeDependents) params.set("include_dependents", "true")
    if (options?.briefDeps) params.set("brief_deps", "true")
    const suffix = params.size ? `?${params}` : ""
    const detail = await this.request<unknown>(
      `/v0/beads/issues/${encodeURIComponent(id)}${suffix}`,
    )
    if (!object(detail) || detail.id !== id)
      throw new ServeHttpError("contract", "Invalid bd serve issue detail")
    return detail as IssueDetails
  }

  async getFullIssue(id: string): Promise<IssueDetails> {
    const detail = await this.getIssue(id, {
      includeComments: true,
      includeDependents: true,
      briefDeps: true,
    })
    validateFullIssueShape(detail)
    validateFullIssuePresence(detail)
    return detail
  }

  async getComments(id: string): Promise<JsonObject[]> {
    const detail = await this.getIssue(id, { includeComments: true })
    if (detail.comments === undefined || detail.comments === null) return []
    if (!Array.isArray(detail.comments))
      throw new ServeHttpError("contract", "Invalid bd serve comments")
    return detail.comments
  }

  async getSetting(key: string): Promise<string | null> {
    if (!this.hasCapability("config.get"))
      throw new ServeHttpError("contract", "bd serve lacks config.get")
    const setting = await this.request<unknown>(`/v0/beads/config/${encodeURIComponent(key)}`)
    if (
      !object(setting) ||
      setting.key !== key ||
      typeof setting.redacted !== "boolean" ||
      (setting.value !== undefined && setting.value !== null && typeof setting.value !== "string")
    )
      throw new ServeHttpError("contract", "Invalid bd serve setting")
    if (setting.redacted)
      throw new ServeHttpError("contract", "bd serve redacted requested setting")
    return (setting.value as string | null | undefined) ?? null
  }
}

export async function requestServeJson<T>(
  address: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${token}`)
  headers.set("Accept", "application/json")
  let response: Response
  try {
    response = await fetch(new URL(path, address), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(10_000),
    })
  } catch {
    throw new ServeHttpError("transport", "bd serve connection failed")
  }
  if (!response.ok) {
    let problem: unknown
    try {
      problem = await response.json()
    } catch {
      /* server may have closed while responding */
    }
    const body = object(problem) ? problem : {}
    const code = typeof body.code === "string" ? body.code : undefined
    const reason = typeof body.reason === "string" ? body.reason : undefined
    const requestId = typeof body.request_id === "string" ? body.request_id : undefined
    const retry = response.headers.get("Retry-After")
    const retryAfter = retry && /^\d+$/.test(retry) ? Number(retry) : undefined
    const kind =
      response.status === 401 ? "auth" : reason === "project_mismatch" ? "identity" : "http"
    throw new ServeHttpError(
      kind,
      `bd serve HTTP ${response.status}`,
      response.status,
      code,
      reason,
      requestId,
      retryAfter,
    )
  }
  try {
    return (await response.json()) as T
  } catch {
    throw new ServeHttpError("contract", "Invalid bd serve JSON response")
  }
}
