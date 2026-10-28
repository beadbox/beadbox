// Census of slow test files (beadbox-mol-dph, systemdesign §7.1).
//
// scripts/slow-tests.txt decides which test files leave the push run
// (scripts/ci-tests.sh fast) and run only nightly. This test scans every test
// file bun discovers in packages/server and packages/client for the causes
// of slowness and requires the list to match, in both directions:
//
//   - MECHANICAL: a file that imports the bd + Dolt fixture
//     (__tests__/fixtures/bd-workspace, directly or through a local helper)
//     or runs `vite build` is on the slow list. No exceptions: every such
//     file measured is slow.
//   - DECIDED: a file with a weak cause (a process spawn, a sleep or
//     setTimeout of 1 s or more, a declared test timeout of 10 s or more) is
//     either on the slow list or in its "# fast:" section with its measured
//     time and why. Weak causes also appear in fast files, so each one is a
//     reviewed decision, like the spawn sites of bd-spawn-census.
//   - Every entry, slow or fast, names a cause the file still has, so an
//     entry whose cause is gone fails and is named.
//   - *.security.test.ts files always run on push and may not be listed.
//
// Causes are read from the AST, so a mention in a comment or a string does
// not count. The detector is tested against synthetic sources below.
// Drift by time alone has no scannable sign; the nightly full run prints the
// slowest files for that.

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import * as ts from "typescript"

const REPO = resolve(import.meta.dir, "..", "..", "..", "..")
const PACKAGES = ["packages/server", "packages/client"]
const LIST = join(REPO, "scripts", "slow-tests.txt")
const SELF = relative(REPO, import.meta.path)
const FIXTURE = /(^|\/)fixtures\/bd-workspace(\.ts)?$/

export const STRONG = ["bd-workspace", "vite build"] as const
// deadline (beadbox-mol-uua.1): a loop whose condition reads the wall clock
// (Date.now() or performance.now()), the shape of "wait until X, or give up at
// T". Its result depends on how busy the machine is, so a file with one is on
// the slow list or decided fast with its reason, never in the push tier unseen.
export const WEAK = ["spawn", "sleep>=1s", "setTimeout>=1s", "timeout>=10s", "deadline"] as const
export type Cause = (typeof STRONG)[number] | (typeof WEAK)[number]
const CAUSES: readonly string[] = [...STRONG, ...WEAK]

// --- what bun test discovers (scripts/ci-tests.sh discover() mirrors this) --

const TEST_FILE = /(\.test|_test|\.spec)\.(ts|tsx|js|jsx)$/

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (TEST_FILE.test(name)) out.push(p)
  }
}

export function discoverTestFiles(): string[] {
  const out: string[] = []
  for (const pkg of PACKAGES) walk(join(REPO, pkg), out)
  return out.map((p) => relative(REPO, p)).sort()
}

const isSecurity = (path: string) => /\.security\.test\.tsx?$/.test(path)

// --- causes, from the AST ------------------------------------------------------

function numberOf(node: ts.Node | undefined, consts: Map<string, number>): number | undefined {
  if (!node) return undefined
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (ts.isParenthesizedExpression(node)) return numberOf(node.expression, consts)
  if (ts.isIdentifier(node)) return consts.get(node.text)
  if (ts.isBinaryExpression(node)) {
    const a = numberOf(node.left, consts)
    const b = numberOf(node.right, consts)
    if (a === undefined || b === undefined) return undefined
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b
  }
  return undefined
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  // test.each(table)("name", fn, timeout): the curried call is still a test.
  if (ts.isCallExpression(expr)) return calleeName(expr.expression)
  return undefined
}

const TEST_CALLS = new Set([
  "test",
  "it",
  "describe",
  "each",
  "skip",
  "only",
  "todo",
  "if",
  "skipIf",
  "failing",
])

function declaredTimeout(call: ts.CallExpression, consts: Map<string, number>): number | undefined {
  const last = call.arguments[call.arguments.length - 1]
  if (call.arguments.length >= 3) {
    const n = numberOf(last, consts)
    if (n !== undefined) return n
  }
  if (last && ts.isObjectLiteralExpression(last)) {
    for (const p of last.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "timeout") {
        return numberOf(p.initializer, consts)
      }
    }
  }
  return undefined
}

/** Date.now() or performance.now() anywhere in an expression. */
function readsWallClock(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "now" &&
    ts.isIdentifier(node.expression.expression) &&
    (node.expression.expression.text === "Date" || node.expression.expression.text === "performance")
  ) {
    return true
  }
  return ts.forEachChild(node, readsWallClock) ?? false
}

export interface Scan {
  causes: Set<Cause>
  imports: string[] // relative module specifiers, for following local helpers
}

export function scanSource(text: string, fileName = "x.ts"): Scan {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const causes = new Set<Cause>()
  const imports: string[] = []
  const consts = new Map<string, number>()

  const visitConsts = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const n = numberOf(node.initializer, consts)
      if (n !== undefined) consts.set(node.name.text, n)
    }
    ts.forEachChild(node, visitConsts)
  }
  visitConsts(sf)

  const moduleRef = (spec: string) => {
    if (FIXTURE.test(spec)) causes.add("bd-workspace")
    if (spec.startsWith(".")) imports.push(spec)
  }

  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) moduleRef(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      const first = node.arguments[0]
      // import("...") / require("...") / mock.module("...")
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === "require") &&
        first &&
        ts.isStringLiteralLike(first)
      ) {
        moduleRef(first.text)
      }
      if (name === "spawn" || name === "spawnSync") causes.add("spawn")
      if (name === "sleep" && (numberOf(first, consts) ?? 0) >= 1000) causes.add("sleep>=1s")
      if (name === "setTimeout" && (numberOf(node.arguments[1], consts) ?? 0) >= 1000)
        causes.add("setTimeout>=1s")
      if (name && TEST_CALLS.has(name) && (declaredTimeout(node, consts) ?? 0) >= 10_000)
        causes.add("timeout>=10s")
    }
    if (
      ((ts.isWhileStatement(node) || ts.isDoStatement(node)) && readsWallClock(node.expression)) ||
      (ts.isForStatement(node) && node.condition !== undefined && readsWallClock(node.condition))
    ) {
      causes.add("deadline")
    }
    // `vite build` in any string or template: the command, not a comment.
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      /\bvite\b.*\bbuild\b/.test(node.getText(sf))
    ) {
      causes.add("vite build")
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { causes, imports }
}

// A test file has the fixture cause if it, or a local module it imports,
// imports the fixture: a wrapper around createBdWorkspace cannot evade it.
function resolveLocal(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec)
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return undefined
}

export function causesOf(path: string): Set<Cause> {
  const abs = join(REPO, path)
  const own = scanSource(readFileSync(abs, "utf8"), abs)
  const causes = new Set(own.causes)
  const seen = new Set([abs])
  const queue = own.imports.map((s) => resolveLocal(abs, s)).filter((p): p is string => !!p)
  while (queue.length && !causes.has("bd-workspace")) {
    const next = queue.shift() as string
    if (seen.has(next) || !next.startsWith(join(REPO, "packages"))) continue
    seen.add(next)
    if (FIXTURE.test(next.replace(/\.tsx?$/, ""))) {
      causes.add("bd-workspace")
      break
    }
    const s = scanSource(readFileSync(next, "utf8"), next)
    if (s.causes.has("bd-workspace")) causes.add("bd-workspace")
    for (const spec of s.imports) {
      const r = resolveLocal(next, spec)
      if (r) queue.push(r)
    }
  }
  return causes
}

// --- the list --------------------------------------------------------------------

export interface Entry {
  section: "slow" | "fast"
  path: string
  cause: string
  line: number
}

export interface Parsed {
  entries: Entry[]
  errors: string[]
}

// Slow entries: "<path>  <cause>  <seconds>". Fast entries are comment lines
// to ci-tests.sh: "# fast: <path>  <cause>  <seconds>  <why...>".
export function parseList(text: string): Parsed {
  const entries: Entry[] = []
  const errors: string[] = []
  text.split("\n").forEach((raw, i) => {
    const line = i + 1
    const fast = raw.match(/^#\s*fast:\s*(.*)$/)
    if (!fast && (raw.trim() === "" || raw.startsWith("#"))) return
    const fields = (fast ? fast[1] : raw).trim().split(/\s+/)
    const [path, cause, seconds, ...why] = fields
    const section = fast ? "fast" : "slow"
    if (!path || !cause || !seconds || !/^\d+(\.\d+)?$/.test(seconds)) {
      errors.push(
        `line ${line}: expected "${fast ? "# fast: " : ""}<path> <cause> <seconds>${fast ? " <why>" : ""}", got "${raw}"`,
      )
      return
    }
    if (fast && why.length === 0)
      errors.push(`line ${line}: # fast: entry for ${path} needs a reason after its seconds`)
    if (!CAUSES.includes(cause))
      errors.push(`line ${line}: ${path}: unknown cause "${cause}" (one of ${CAUSES.join(", ")})`)
    entries.push({ section, path, cause, line })
  })
  return { entries, errors }
}

// The whole contract, as a list of errors (empty = the list matches).
export function census(
  files: string[],
  listText: string,
  causesFor: (path: string) => Set<Cause>,
): string[] {
  const { entries, errors } = parseList(listText)
  const known = new Set(files)
  const bySection = new Map<string, Entry>()
  for (const e of entries) {
    const prior = bySection.get(e.path)
    if (prior) errors.push(`${e.path} is listed twice (lines ${prior.line} and ${e.line})`)
    bySection.set(e.path, e)
    if (!known.has(e.path))
      errors.push(`${e.path} (line ${e.line}) is not a test file bun discovers`)
    if (isSecurity(e.path))
      errors.push(`${e.path} is a security test; it always runs on push and may not be listed`)
  }

  for (const path of files) {
    if (path === SELF || isSecurity(path)) continue
    const causes = causesFor(path)
    const entry = bySection.get(path)
    const strong = STRONG.filter((c) => causes.has(c))
    const weak = WEAK.filter((c) => causes.has(c))

    if (entry && !causes.has(entry.cause as Cause)) {
      const has = [...causes].join(", ") || "none"
      errors.push(
        `${path} is in the ${entry.section} list (line ${entry.line}) for "${entry.cause}", which it no longer has (causes now: ${has}); ` +
          (causes.size ? "name a cause it has" : "remove the entry"),
      )
    }
    if (strong.length && entry?.section !== "slow") {
      errors.push(
        `${path} uses ${strong.join(" and ")}, so it must be on the slow list${entry ? ` (it is in # fast:, line ${entry.line})` : ""}`,
      )
    } else if (weak.length && !entry) {
      errors.push(
        `${path} has ${weak.join(", ")} and is in neither section: add it to the slow list, or to "# fast:" with its measured time and why`,
      )
    }
  }
  return errors
}

// --- the real list -------------------------------------------------------------

// An explicit timeout, so the scan of every test file never inherits a
// shorter default from the run around it: in a pre-push run on a loaded
// machine it was cut off at 6 s.
const SCAN_TIMEOUT_MS = 60_000

describe("slow-test census (beadbox-mol-dph)", () => {
  const files = discoverTestFiles()

  test("the scan sees both packages", () => {
    expect(files.filter((f) => f.startsWith("packages/server/")).length).toBeGreaterThan(50)
    expect(files.filter((f) => f.startsWith("packages/client/")).length).toBeGreaterThan(50)
  })

  test(
    "scripts/slow-tests.txt matches the causes in the test files",
    () => {
      expect(census(files, readFileSync(LIST, "utf8"), causesOf)).toEqual([])
    },
    SCAN_TIMEOUT_MS,
  )
})

// --- the detector, against synthetic sources --------------------------------------

const causesIn = (src: string, name = "x.test.ts") => [...scanSource(src, name).causes].sort()

describe("census detector (beadbox-mol-dph)", () => {
  test("the fixture import, by any form", () => {
    expect(causesIn(`import { createBdWorkspace } from "./fixtures/bd-workspace"`)).toEqual([
      "bd-workspace",
    ])
    expect(causesIn(`import * as w from "../__tests__/fixtures/bd-workspace.ts"`)).toEqual([
      "bd-workspace",
    ])
    expect(causesIn(`const w = await import("./fixtures/bd-workspace")`)).toEqual(["bd-workspace"])
    expect(causesIn(`// import { createBdWorkspace } from "./fixtures/bd-workspace"`)).toEqual([])
    expect(causesIn(`import { other } from "./fixtures/bd-workspace-paths"`)).toEqual([])
  })

  test("spawns, as calls only", () => {
    expect(causesIn(`Bun.spawn(["sh"])`)).toEqual(["spawn"])
    expect(causesIn(`Bun.spawnSync(["sh"])`)).toEqual(["spawn"])
    expect(causesIn(`import { spawn } from "node:child_process"; spawn("sh")`)).toEqual(["spawn"])
    expect(causesIn(`const s = "spawn(sh)" // spawn(x)`)).toEqual([])
  })

  test("waits count from 1 s, constants and separators included", () => {
    expect(causesIn(`await Bun.sleep(1_000)`)).toEqual(["sleep>=1s"])
    expect(causesIn(`await Bun.sleep(999)`)).toEqual([])
    expect(causesIn(`const WAIT = 2 * 1000; await sleep(WAIT)`)).toEqual(["sleep>=1s"])
    expect(causesIn(`await new Promise((r) => setTimeout(r, 1500))`)).toEqual(["setTimeout>=1s"])
    expect(causesIn(`setTimeout(() => {}, 50)`)).toEqual([])
    expect(causesIn(`setTimeout(() => {}, delay)`)).toEqual([])
  })

  test("declared test timeouts count from 10 s", () => {
    expect(causesIn(`test("x", () => {}, 60_000)`)).toEqual(["timeout>=10s"])
    expect(causesIn(`it("x", async () => {}, { timeout: 15_000 })`)).toEqual(["timeout>=10s"])
    expect(causesIn(`test.each([1, 2])("x %p", (n) => {}, 30_000)`)).toEqual(["timeout>=10s"])
    expect(causesIn(`test("x", () => {}, 5_000)`)).toEqual([])
    expect(causesIn(`describe("x", () => { test("y", () => {}) })`)).toEqual([])
  })

  test("a wall-clock deadline is a loop that reads the clock, not date arithmetic (beadbox-mol-uua.1)", () => {
    expect(causesIn(`const end = Date.now() + 4000; while (Date.now() < end && !done()) await poll()`)).toEqual([
      "deadline",
    ])
    expect(causesIn(`do { await poll() } while (performance.now() - t0 < 2000)`)).toEqual(["deadline"])
    expect(causesIn(`for (let t = Date.now(); Date.now() - t < ms; ) step()`)).toEqual(["deadline"])
    expect(causesIn(`const due = new Date(Date.now() + 86_400_000)`)).toEqual([])
    expect(causesIn(`const elapsed = performance.now() - t0; expect(elapsed).toBeGreaterThan(0)`)).toEqual([])
    expect(causesIn(`while (queue.length) drain()`)).toEqual([])
  })

  test("vite build as a command string, not a comment", () => {
    expect(causesIn('Bun.spawnSync(["sh", "-c", "node_modules/.bin/vite build"])')).toEqual([
      "spawn",
      "vite build",
    ])
    expect(causesIn(`// then vite build runs`)).toEqual([])
  })
})

describe("census contract (beadbox-mol-dph)", () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.security.test.ts", "e.test.ts"]
  const causes: Record<string, Cause[]> = {
    "a.test.ts": ["bd-workspace"],
    "b.test.ts": ["spawn"],
    "c.test.ts": [],
    "d.security.test.ts": ["spawn", "sleep>=1s"],
    "e.test.ts": ["timeout>=10s"],
  }
  const of = (p: string) => new Set(causes[p])
  const good = [
    "a.test.ts bd-workspace 30",
    "b.test.ts spawn 6",
    "# fast: e.test.ts timeout>=10s 0.4 a ceiling, not a wait",
  ].join("\n")

  test("the correct list passes", () => {
    expect(census(files, good, of)).toEqual([])
  })

  test("a slow file missing from the list fails, naming it", () => {
    const errors = census(files, good.replace("a.test.ts bd-workspace 30", ""), of)
    expect(errors).toEqual([
      expect.stringContaining("a.test.ts uses bd-workspace, so it must be on the slow list"),
    ])
  })

  test("a fixture file in # fast: fails: the mechanical rule has no exceptions", () => {
    const errors = census(
      files,
      good.replace("a.test.ts bd-workspace 30", "# fast: a.test.ts bd-workspace 1 quick"),
      of,
    )
    expect(errors).toEqual([
      expect.stringContaining(
        "a.test.ts uses bd-workspace, so it must be on the slow list (it is in # fast:",
      ),
    ])
  })

  test("a listed file with none of its causes fails, naming it", () => {
    const errors = census(files, `${good}\nc.test.ts spawn 9`, of)
    expect(errors).toEqual([
      expect.stringContaining(
        'c.test.ts is in the slow list (line 4) for "spawn", which it no longer has',
      ),
    ])
  })

  test("a # fast: entry whose cause is gone fails too", () => {
    const errors = census(files, good, (p) => (p === "e.test.ts" ? new Set() : of(p)))
    expect(errors).toEqual([
      expect.stringContaining(
        'e.test.ts is in the fast list (line 3) for "timeout>=10s", which it no longer has',
      ),
    ])
  })

  test("a wall-clock deadline in the push tier with no entry fails, naming it (beadbox-mol-uua.1)", () => {
    const withDeadline = (p: string) => (p === "c.test.ts" ? new Set<Cause>(["deadline"]) : of(p))
    expect(census(files, good, withDeadline)).toEqual([
      expect.stringContaining("c.test.ts has deadline and is in neither section"),
    ])
    expect(census(files, `${good}\n# fast: c.test.ts deadline 0.2 a hang guard on a quick poll`, withDeadline)).toEqual([])
  })

  test("a weak-cause file in neither section fails", () => {
    const errors = census(
      files,
      good.replace("# fast: e.test.ts timeout>=10s 0.4 a ceiling, not a wait", ""),
      of,
    )
    expect(errors).toEqual([
      expect.stringContaining("e.test.ts has timeout>=10s and is in neither section"),
    ])
  })

  test("security tests are exempt from the scan and may not be listed", () => {
    expect(census(files, good, of)).toEqual([])
    const errors = census(files, `${good}\nd.security.test.ts spawn 3`, of)
    expect(errors).toEqual([expect.stringContaining("d.security.test.ts is a security test")])
  })

  test("malformed lines, unknown causes, unknown files and duplicates fail", () => {
    expect(census(files, `${good}\nb.test.ts`, of)).toEqual([
      expect.stringContaining("line 4: expected"),
    ])
    expect(census(files, `${good}\nb.test.ts slowish 3`, of)).toEqual(
      expect.arrayContaining([expect.stringContaining('unknown cause "slowish"')]),
    )
    expect(census(files, `${good}\nz.test.ts spawn 3`, of)).toEqual([
      expect.stringContaining("z.test.ts (line 4) is not a test file"),
    ])
    expect(census(files, `${good}\nb.test.ts spawn 6`, of)).toEqual([
      expect.stringContaining("b.test.ts is listed twice"),
    ])
    expect(census(files, `${good}\n# fast: c.test.ts spawn 1`, of)).toEqual(
      expect.arrayContaining([expect.stringContaining("needs a reason")]),
    )
  })
})
