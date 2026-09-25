// Census of every SQL call on a direct database connection in packages/server
// (beadbox-01f.8).
//
// server:// workspaces never reach the bd CLI, so `bd sql --readonly` cannot
// guard their reads; lib/read-only-query.ts does, by running each one inside
// a READ ONLY transaction the server enforces. read-only-query.test covers
// what the helper DOES. This covers whether anything goes AROUND it: the test
// walks the AST of every non-test source file, finds every .query( /
// .execute( call, and requires the set to EXACTLY match the reviewed table
// below. A new call site (a raw conn.query in serverSqlQuery, say) fails
// until someone reviews it and writes down why it may skip the helper; a
// removed one fails until its entry is deleted, so the table cannot drift.
//
// Same shape as bd-spawn-census.security.test.ts: the walker's detection is
// tested against synthetic sources, and a text-level backstop catches forms
// the walker does not model.

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import * as ts from "typescript"

const SRC = dirname(import.meta.dir)

// Key: "<file>::<enclosing function chain>::<callee as written>".
const REVIEWED: Record<string, { count: number; why: string }> = {
  "lib/read-only-query.ts::readOnlyQuery::conn.query": {
    count: 4,
    why: "the guard itself: START TRANSACTION READ ONLY, the read, COMMIT, ROLLBACK",
  },
  "lib/bd.ts::discoverServerDatabases::connection.query": {
    count: 2,
    why: "self-directed probes of the server being added (SHOW DATABASES; SELECT 1 FROM <name>.issues with a server-supplied name); mysql2 multipleStatements is never enabled, so a name cannot become a second, writing statement",
  },
  "lib/change-detector.ts::serverPoll::pool.query": {
    count: 1,
    why: "constant SERVER_POLL_SQL (DOLT_HASHOF_TABLE reads) on the legacy in-process poll, reachable only on the warned fallback when server mode starts without a subscription id",
  },
  "lib/dolt-pool.ts::getPool::pool.query": {
    count: 1,
    why: "constant SELECT 1 liveness probe",
  },
  "lib/dolt-pool.ts::getPool::retryPool.query": {
    count: 1,
    why: "constant SELECT 1 liveness probe on the retry pool",
  },
  "lib/workspace-health.ts::checkServerOnlyWorkspace::conn.query": {
    count: 1,
    why: "constant SELECT 1 reachability probe",
  },
  "lib/port-scan.ts::probePort::connection.query": {
    count: 1,
    why: "constant SELECT @@dolt_version server-identity probe",
  },
}

// Text-level backstop. The walker models call forms one by one; a form it
// does not model would leave the census green. So independently of the
// walker: every source file whose CODE (comments stripped) mentions a
// query/execute member or the mysql2 driver must contribute at least one
// census entry, or be listed here with a reason.
const SQL_TEXT = /\.\s*(query|execute)\b|\[\s*["'`](query|execute)["'`]\s*\]|\bmysql2\b|\{\s*(query|execute)\b/
const BACKSTOP_REVIEWED: Record<string, string> = {}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

const SQL_METHODS = new Set(["query", "execute"])

type Sources = Record<string, string> // relative path -> source text

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression
  }
  return e
}

/** x.query / x["query"] (and execute): a SQL method pulled off some object. */
function isSqlMember(expr: ts.Expression): boolean {
  const e = unwrap(expr)
  if (ts.isPropertyAccessExpression(e)) return SQL_METHODS.has(e.name.text)
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return SQL_METHODS.has(e.argumentExpression.text)
  }
  return false
}

/** Local names bound to a SQL method: const q = c.query, c.query.bind(c), const { query: q } = c. */
function sqlLocals(sf: ts.SourceFile): Set<string> {
  const locals = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer)
      if (ts.isIdentifier(node.name)) {
        const bound =
          isSqlMember(init) ||
          (ts.isCallExpression(init) &&
            ts.isPropertyAccessExpression(unwrap(init.expression)) &&
            (unwrap(init.expression) as ts.PropertyAccessExpression).name.text === "bind" &&
            isSqlMember((unwrap(init.expression) as ts.PropertyAccessExpression).expression))
        if (bound) locals.add(node.name.text)
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name
          if (ts.isIdentifier(key) && ts.isIdentifier(el.name) && SQL_METHODS.has(key.text)) {
            locals.add(el.name.text)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return locals
}

/** The callee runs SQL: x.query(...), x["query"](...), x.query.call/apply(...), or a bound local. */
function isSqlCallee(callee: ts.Expression, locals: Set<string>): boolean {
  const e = unwrap(callee)
  if (ts.isIdentifier(e)) return locals.has(e.text)
  if (isSqlMember(e)) return true
  return (
    ts.isPropertyAccessExpression(e) &&
    (e.name.text === "call" || e.name.text === "apply") &&
    isSqlCallee(e.expression, locals)
  )
}

function enclosingChain(node: ts.Node): string {
  const names: string[] = []
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    ) {
      names.unshift(n.name.text)
    } else if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      names.unshift(n.parent.name.text)
    }
  }
  return names.length ? names.join(">") : "<module>"
}

/** Every SQL call: "<file>::<enclosing chain>::<callee as written>" -> count. */
function census(sources: Sources): Record<string, number> {
  const found: Record<string, number> = {}
  for (const [f, text] of Object.entries(sources)) {
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true)
    const locals = sqlLocals(sf)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isSqlCallee(node.expression, locals)) {
        const key = `${f}::${enclosingChain(node)}::${node.expression.getText(sf)}`
        found[key] = (found[key] ?? 0) + 1
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return found
}

/** Files whose comment-stripped code mentions a SQL-shaped member or the driver. */
function sqlShapedFiles(sources: Sources): string[] {
  const printer = ts.createPrinter({ removeComments: true })
  return Object.entries(sources)
    .filter(([p, text]) => {
      const code = printer.printFile(ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true))
      return SQL_TEXT.test(code)
    })
    .map(([p]) => p)
}

/**
 * Every use of the connection created in serverSqlQuery, as "conn.<member>"
 * or "<callee>(conn)"; anything else is reported as written. Sorted and
 * de-duplicated, so a new use of any shape changes the list.
 */
function connectionUses(bdSource: string): string[] {
  const sf = ts.createSourceFile("lib/bd.ts", bdSource, ts.ScriptTarget.Latest, true)
  let fn: ts.FunctionDeclaration | undefined
  const find = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "serverSqlQuery") fn = n
    else ts.forEachChild(n, find)
  }
  find(sf)
  if (!fn?.body) throw new Error("serverSqlQuery not found in lib/bd.ts")
  const uses = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === "conn" && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n)) {
      const p = n.parent
      if (ts.isPropertyAccessExpression(p) && p.expression === n) uses.add(`conn.${p.name.text}`)
      else if (ts.isCallExpression(p) && p.arguments.includes(n)) {
        uses.add(`${p.expression.getText(sf).replace(/<.*>$/, "")}(conn)`)
      } else uses.add(p.getText(sf))
    }
    ts.forEachChild(n, visit)
  }
  visit(fn.body)
  return [...uses].sort()
}

function serverSources(): Sources {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : walk(path)
      return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : []
    })
  if (!existsSync(SRC)) throw new Error(`missing ${SRC}`)
  return Object.fromEntries(walk(SRC).map((p) => [relative(SRC, p), readFileSync(p, "utf-8")]))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("census walker sees every SQL call form (so it cannot pass by not looking)", () => {
  const found = census({
    "lib/forms.ts": [
      `async function viaMember(conn: any) { await conn.query("x"); await conn.execute("y") }`,
      `const viaArrow = async (pool: any) => { await pool.query("x") }`,
      `async function viaElement(c: any) { await c["query"]("x") }`,
      `async function viaCast(c: unknown) { await (c as any).query("x") }`,
      `async function viaCall(c: any) { await c.query.call(c, "x") }`,
      `async function viaBound(c: any) { const q = c.query.bind(c); await q("x") }`,
      `async function viaAlias(c: any) { const run = c.execute; await run("x") }`,
      `async function viaDestructure(c: any) { const { query } = c; const { execute: ex } = c; await query("x"); await ex("y") }`,
      `function notSql(c: any) { c.queryAll("x"); c.exec("x"); query2("x") }`,
    ].join("\n"),
  })

  test("member, element, cast, call/apply, bind, alias and destructure forms are all found", () => {
    expect(Object.keys(found).sort()).toEqual(
      [
        "lib/forms.ts::viaAlias::run",
        "lib/forms.ts::viaArrow::pool.query",
        "lib/forms.ts::viaBound::q",
        "lib/forms.ts::viaCall::c.query.call",
        "lib/forms.ts::viaCast::(c as any).query",
        "lib/forms.ts::viaDestructure::ex",
        "lib/forms.ts::viaDestructure::query",
        'lib/forms.ts::viaElement::c["query"]',
        "lib/forms.ts::viaMember::conn.execute",
        "lib/forms.ts::viaMember::conn.query",
      ].sort(),
    )
  })

  test("a raw query in serverSqlQuery is a NEW site the table does not contain", () => {
    const raw = census({
      "lib/bd.ts": `async function serverSqlQuery(sql: string) { const conn: any = {}; const [r] = await conn.query(sql); return r }`,
    })
    expect(Object.keys(raw)).toEqual(["lib/bd.ts::serverSqlQuery::conn.query"])
    expect(REVIEWED["lib/bd.ts::serverSqlQuery::conn.query"]).toBeUndefined()
  })
})

describe("serverSqlQuery wiring check sees every way the connection can leave the helper", () => {
  const body = (inner: string) =>
    `async function serverSqlQuery<T>(sql: string) {\n  const conn: any = await open()\n  try {\n${inner}\n  } finally {\n    await conn.end()\n  }\n}`
  const ALLOWED = ["conn.end", "readOnlyQuery(conn)"]

  test("the routed form is exactly the allowed uses", () => {
    expect(connectionUses(body("    return await readOnlyQuery<T>(conn, sql)"))).toEqual(ALLOWED)
  })

  test("a direct computed-member call is reported", () => {
    // The routed call stays, so only the bypass can change the list.
    const src = body(
      `    const m = "que" + "ry"\n    await (conn as any)[m](sql)\n    return await readOnlyQuery<T>(conn, sql)`,
    )
    expect(connectionUses(src)).not.toEqual(ALLOWED)
  })

  test("an ALIASED connection is reported (const c = conn; c[m](sql))", () => {
    const src = body(
      `    const c = conn\n    const m = "que" + "ry"\n    await c[m](sql)\n    return await readOnlyQuery<T>(conn, sql)`,
    )
    expect(connectionUses(src)).not.toEqual(ALLOWED)
  })
})

describe("text-level backstop catches forms the walker does not model", () => {
  test("a file with SQL-shaped code and no census entry is reported", () => {
    const sources = {
      // Computed member name: invisible to the walker by construction.
      "lib/evasive.ts": `export async function x(c: any) { const m = "que" + "ry"; await c[m]("DELETE FROM t") }\nimport mysql from "mysql2/promise"`,
      // Comments are stripped first, so prose about conn.query is not a call.
      "lib/prose.ts": `// runs conn.query elsewhere via mysql2\nexport const y = 1`,
    }
    const found = census(sources)
    const covered = new Set(Object.keys(found).map((k) => k.split("::")[0]))
    expect(Object.keys(found)).toEqual([])
    expect(sqlShapedFiles(sources).filter((f) => !covered.has(f))).toEqual(["lib/evasive.ts"])
  })
})

describe("SQL-site census of packages/server", () => {
  const found = census(serverSources())

  test("the census found SQL sites (a walker that finds nothing is broken)", () => {
    expect(Object.keys(found).length).toBeGreaterThanOrEqual(5)
  })

  test("serverSqlQuery reaches the database only through readOnlyQuery", () => {
    expect(Object.keys(found).filter((k) => k.startsWith("lib/bd.ts::serverSqlQuery"))).toEqual([])
    // The census and the backstop key on call SHAPES, and bd.ts already has
    // reviewed sites, so a computed-member call (conn[m](sql)) inside
    // serverSqlQuery would pass both. Pin the wiring itself instead: the
    // connection may only be handed to readOnlyQuery or ended.
    expect(connectionUses(readFileSync(join(SRC, "lib/bd.ts"), "utf-8"))).toEqual([
      "conn.end",
      "readOnlyQuery(conn)",
    ])
  })

  test("every SQL site is reviewed, and every reviewed entry still exists", () => {
    const actual = Object.entries(found)
      .map(([k, n]) => `${k} x${n}`)
      .sort()
    const expected = Object.entries(REVIEWED)
      .map(([k, v]) => `${k} x${v.count}`)
      .sort()
    expect(actual).toEqual(expected)
  })

  test("backstop: every file with SQL-shaped code has a census entry or a reviewed reason", () => {
    const sources = serverSources()
    const covered = new Set(Object.keys(found).map((k) => k.split("::")[0]))
    const shaped = sqlShapedFiles(sources)
    const uncovered = shaped.filter((f) => !covered.has(f) && !(f in BACKSTOP_REVIEWED))
    expect(uncovered).toEqual([])
    const stale = Object.keys(BACKSTOP_REVIEWED).filter(
      (f) => !shaped.includes(f) || covered.has(f),
    )
    expect(stale).toEqual([])
    expect(shaped.length).toBeGreaterThanOrEqual(5)
  })

  test("every reviewed entry states why it may skip the read-only helper", () => {
    expect(Object.entries(REVIEWED).filter(([, v]) => v.why.trim().length < 20)).toEqual([])
  })
})
