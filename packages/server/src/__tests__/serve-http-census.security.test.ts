// Census of outbound HTTP in packages/server (beadbox-6x2 L3, sec C4 + C5).
//
// The shipped sidecar opens no listener (no-network-listener.test.ts). With
// the serve-reads pilot, bd opens one on loopback and the sidecar talks to it.
// That client may do exactly one thing: GET a fixed set of read paths from
// the address ServeManager parsed from its own child. This pins it:
//
//  1. Exactly one fetch call in shipped server source, in lib/serve-http.ts.
//  2. Its URL is built by serveUrl() (directly, or a const initialised by it
//     in the same function), and serveUrl only accepts the loopback base.
//  3. It passes no method other than GET, so no write verb can be sent, and
//     it sets redirect: "error", so a response cannot steer the request (and
//     its bearer token) to another address.
//  4. The /v0/ path templates in serve-http.ts EXACTLY equal the reviewed set.
//  5. Backstop: no other outbound-HTTP primitive anywhere in server source.
//
// The walker is tested against synthetic sources, so it cannot pass by not
// looking.

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import * as ts from "typescript"
import { ServeHttpError, serveUrl } from "../lib/serve-http"

const SRC = dirname(import.meta.dir)
const CLIENT_FILE = "lib/serve-http.ts"

const REVIEWED_PATHS = [
  "/v0/beads/config/{}",
  "/v0/beads/context",
  "/v0/beads/issues/{}?include_comments=true&include_dependents=true&brief_deps=true",
  "/v0/beads/issues?{}",
  "/v0/beads/ready?limit=1",
].sort()

// serveUrl's own guard literal, not a request path.
const PATH_GUARD = "/v0/beads/"

const OUTBOUND_TEXT = /XMLHttpRequest|\bhttps?\s*\.\s*(request|get)\s*\(|new\s+WebSocket\b|from\s+["'](node:)?https?["']|\bfetch\b/

type Sources = Record<string, string>

interface FetchSite {
  file: string
  urlFromServeUrl: boolean
  methods: string[] // "GET" or the text of a non-GET method
  redirect: string // the literal redirect mode, or how it was written if not a literal
}

function fetchSites(sources: Sources): FetchSite[] {
  const sites: FetchSite[] = []
  for (const [file, text] of Object.entries(sources)) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const isFetch =
          (ts.isIdentifier(callee) && callee.text === "fetch") ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch") ||
          (ts.isElementAccessExpression(callee) &&
            ts.isStringLiteralLike(callee.argumentExpression) &&
            callee.argumentExpression.text === "fetch")
        if (isFetch) {
          sites.push({ file, urlFromServeUrl: urlIsServeUrl(node), methods: methodsOf(node, sf), redirect: redirectOf(node, sf) })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return sites
}

const isServeUrlCall = (e: ts.Expression | undefined) =>
  !!e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "serveUrl"

/** The first argument is serveUrl(...), or a const initialised by it in the enclosing function. */
function urlIsServeUrl(call: ts.CallExpression): boolean {
  const arg = call.arguments[0]
  if (isServeUrlCall(arg)) return true
  if (!arg || !ts.isIdentifier(arg)) return false
  let fn: ts.Node | undefined = call.parent
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent
  let found = false
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === arg.text &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0 &&
      isServeUrlCall(n.initializer)
    ) {
      found = true
    }
    ts.forEachChild(n, visit)
  }
  if (fn) visit(fn)
  return found
}

/** Every method a fetch could send: absent = GET; a literal; anything else is reported as written. */
function methodsOf(call: ts.CallExpression, sf: ts.SourceFile): string[] {
  const init = call.arguments[1]
  if (!init) return ["GET"]
  if (!ts.isObjectLiteralExpression(init)) return [`<non-literal init: ${init.getText(sf)}>`]
  const out: string[] = []
  for (const p of init.properties) {
    if (ts.isSpreadAssignment(p)) out.push(`<spread: ${p.getText(sf)}>`)
    else if (p.name && p.name.getText(sf).replace(/["']/g, "") === "method") {
      const v = ts.isPropertyAssignment(p) ? p.initializer : undefined
      out.push(v && ts.isStringLiteralLike(v) ? v.text.toUpperCase() : `<method: ${p.getText(sf)}>`)
    }
  }
  return out.length ? out : ["GET"]
}

/** The redirect mode a fetch uses: a literal, "<absent>" (the default, "follow"), or how it was written. */
function redirectOf(call: ts.CallExpression, sf: ts.SourceFile): string {
  const init = call.arguments[1]
  if (!init || !ts.isObjectLiteralExpression(init)) return "<absent>"
  for (const p of init.properties) {
    if (p.name && p.name.getText(sf).replace(/["']/g, "") === "redirect") {
      const v = ts.isPropertyAssignment(p) ? p.initializer : undefined
      return v && ts.isStringLiteralLike(v) ? v.text : `<redirect: ${p.getText(sf)}>`
    }
  }
  return "<absent>"
}

/** /v0/ string and template literals, with ${...} spans written as {}. */
function pathTemplates(text: string): string[] {
  const sf = ts.createSourceFile(CLIENT_FILE, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (n: ts.Node) => {
    let s: string | null = null
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) s = n.text
    else if (ts.isTemplateExpression(n)) s = n.head.text + n.templateSpans.map((sp) => `{}${sp.literal.text}`).join("")
    if (s?.startsWith("/v0/")) out.push(s)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function codeOnly(file: string, text: string): string {
  return ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
}

function serverSources(): Sources {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) return name === "__tests__" ? [] : walk(p)
      return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [p] : []
    })
  return Object.fromEntries(walk(SRC).map((p) => [relative(SRC, p), readFileSync(p, "utf-8")]))
}

// ---------------------------------------------------------------------------

describe("the walker sees every fetch form and every method (so it cannot pass by not looking)", () => {
  const sites = fetchSites({
    "a.ts": [
      `async function direct(e: any) { await fetch(serveUrl(e, "/v0/beads/context")) }`,
      `async function viaConst(e: any) { const url = serveUrl(e, "/v0/x"); await fetch(url, { headers: {} }) }`,
      `async function viaLet(e: any) { let url = serveUrl(e, "/v0/x"); await fetch(url) }`,
      `async function raw() { await fetch("http://127.0.0.1:1/v0/beads/context") }`,
      `async function post(e: any) { await fetch(serveUrl(e, "/v0/x"), { method: "POST" }) }`,
      `async function dyn(e: any, m: string) { await fetch(serveUrl(e, "/v0/x"), { method: m }) }`,
      `async function spread(e: any, o: any) { await fetch(serveUrl(e, "/v0/x"), { ...o }) }`,
      `async function global(e: any) { await globalThis.fetch(serveUrl(e, "/v0/x")) }`,
      `async function element(e: any) { await (globalThis as any)["fetch"]("http://x") }`,
      `async function noFollow(e: any) { await fetch(serveUrl(e, "/v0/x"), { redirect: "error" }) }`,
      `async function dynRedirect(e: any, r: any) { await fetch(serveUrl(e, "/v0/x"), { redirect: r }) }`,
    ].join("\n"),
  })
  test("each form is found, with its url provenance and methods", () => {
    expect(sites.map((s) => [s.urlFromServeUrl, s.methods]).slice(0, 9)).toEqual([
      [true, ["GET"]],
      [true, ["GET"]],
      [false, ["GET"]], // let: could be reassigned
      [false, ["GET"]],
      [true, ["POST"]],
      [true, ["<method: method: m>"]],
      [true, ["<spread: ...o>"]],
      [true, ["GET"]],
      [false, ["GET"]],
    ])
  })
  test("the redirect mode is read, not assumed", () => {
    expect(sites.map((s) => s.redirect).slice(-3)).toEqual(["<absent>", "error", "<redirect: redirect: r>"])
  })
})

describe("serveUrl accepts only the loopback base and read-API paths", () => {
  test("rejects anything else", () => {
    const bad: Array<[string, string]> = [
      ["http://0.0.0.0:1234", "/v0/beads/context"],
      ["http://localhost:1234", "/v0/beads/context"],
      ["https://127.0.0.1:1234", "/v0/beads/context"],
      ["http://127.0.0.1:1234/x", "/v0/beads/context"],
      ["http://127.0.0.1:0", "/v0/beads/context"],
      ["http://127.0.0.1:1234", "/healthz"],
      ["http://127.0.0.1:1234", "//evil.example/v0/beads/"],
    ]
    for (const [url, path] of bad) {
      expect(() => serveUrl({ url, token: "t" }, path)).toThrow(ServeHttpError)
    }
    expect(serveUrl({ url: "http://127.0.0.1:1234", token: "t" }, "/v0/beads/context")).toBe(
      "http://127.0.0.1:1234/v0/beads/context",
    )
  })
})

describe("outbound HTTP census of packages/server", () => {
  const sources = serverSources()
  const sites = fetchSites(sources)

  test("the scan saw the source tree (a sweep of nothing is not a pass)", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50)
  })

  test("exactly one fetch, in lib/serve-http.ts, with a serveUrl-built URL, GET only, and redirects refused", () => {
    expect(sites).toEqual([{ file: CLIENT_FILE, urlFromServeUrl: true, methods: ["GET"], redirect: "error" }])
  })

  test("the read paths are exactly the reviewed set", () => {
    const found = pathTemplates(sources[CLIENT_FILE] ?? "").filter((p) => p !== PATH_GUARD)
    expect([...new Set(found)].sort()).toEqual(REVIEWED_PATHS)
  })

  test("backstop: no other file uses any outbound-HTTP primitive", () => {
    const offenders = Object.entries(sources)
      .filter(([file, text]) => file !== CLIENT_FILE && OUTBOUND_TEXT.test(codeOnly(file, text)))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })
})
