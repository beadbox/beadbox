// Census of every process spawn in packages/server (beadbox-c29).
//
// bd-exports-argv.security.test.ts fuzzes every exported function of
// lib/bd.ts. That only covers the bd binary if lib/bd.ts is where bd gets
// spawned — and it is not the only place. This test walks the AST of every
// non-test source file, finds every process-spawn call, and requires the set
// to EXACTLY match the reviewed table below. A new spawn site fails until
// someone reviews it and writes down why its argv is safe; a removed one fails
// until its entry is deleted, so the table cannot drift into fiction.
//
// Spawners are tracked by BINDING, not by name: anything imported from
// child_process (named, aliased or namespace), anything wrapped with
// promisify(), anything another module exports that is one of those, and
// Bun.spawn / Bun.spawnSync / Bun.$. The walker's own detection is tested
// against synthetic sources, so it cannot pass by failing to see a form.

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import * as ts from "typescript"

const SRC = dirname(import.meta.dir)

// Key: "<file>::<enclosing function chain>::<spawner>". lib/bd.ts sites are
// covered by the export fuzz (bd-exports-argv.security.test.ts) through their
// exported callers; every other site says what reaches its argv.
const BD_TS_FUZZED = "lib/bd.ts: covered by the export fuzz via its exported callers"
const REVIEWED: Record<string, { count: number; why: string }> = {
  // --- lib/bd.ts: the bd API surface, fuzzed slot by slot ---
  "lib/bd.ts::execBdWithRetry::execFileAsync": { count: 2, why: BD_TS_FUZZED },
  "lib/bd.ts::initServerScaffold::execFileAsync": { count: 1, why: BD_TS_FUZZED },
  "lib/bd.ts::initWorkspace::execFileAsync": { count: 2, why: BD_TS_FUZZED },
  "lib/bd.ts::listActivity::execFileAsync": { count: 2, why: BD_TS_FUZZED },

  // --- bd spawned outside lib/bd.ts ---
  "handlers/console.ts::run::execFileAsync": {
    count: 1,
    why: "the in-app bd console: argv IS the user's typed command by design, gated by ALLOWED_COMMANDS / ALLOWED_SUBCOMMANDS / MUTATING_SUBCOMMAND_ANYWHERE; --db is isValidDbPath-checked",
  },
  "handlers/diagnostics.ts::runDiagnostics::execFileAsync": {
    count: 1,
    why: "fixed argv (doctor --agent --json); the only variable is --db, isValidDbPath-checked and passed as the value of a two-token --db",
  },
  "handlers/health.ts::checkBdHealth::execFileAsync": {
    count: 1,
    why: "fixed argv: bd --version; no input",
  },
  "handlers/health.ts::getToolVersions::execFileAsync": {
    count: 2,
    why: "fixed argv: bd version --json / bd --version; no input",
  },
  "handlers/health.ts::runWorkspaceMigration::execFileAsync": {
    count: 1,
    why: "migrate --db=<path> --yes: refuses a relative, non-.beads or unregistered path before spawning; bd receives the REGISTERED local.path as a single --db= token (beadbox-226, health-migration.security.test.ts)",
  },
  "handlers/recovery.ts::runRecoveryCommand::execFileAsync": {
    count: 1,
    why: "argv comes from ALLOWED_FIX_COMMANDS keyed by the client's command name (unknown key rejected); --db is isValidDbPath-checked and normalized",
  },
  "handlers/recovery.ts::migrateToServerMode>run::execFileAsync": {
    count: 1,
    why: "fixed verbs; --db is isValidDbPath-checked. --prefix <prefix> reads metadata.json (repo-controlled) as the value of a two-token flag: not a flag injection, but the fragile form (beadbox-c29 finding F-4)",
  },
  "lib/change-detector.ts::bdServerPoll::execFile": {
    count: 1,
    why: "fixed SQL poll; --db is normalizeDbPath of the registry path, value of a two-token --db. KNOWN GAP (beadbox-c29 finding F-3): spawns bare 'bd' via PATH, not resolveBdPath()",
  },
  "lib/change-detector.ts::startServerPollChild::spawn": {
    count: 1,
    why: "/bin/sh poll loop: the db path and bd path are quoted positionals ($2, $3), never spliced into the script; enforced by change-detector-shell-argv.security.test.ts",
  },
  "lib/workspace-health.ts::probeBdVersion::execFileAsync": {
    count: 1,
    why: "fixed argv: bd --version; no input",
  },
  "lib/workspace-health.ts::checkLocalWorkspace::execFileAsync": {
    count: 1,
    why: "fixed argv (list --json --limit 1); --db is resolveBdDbPath of the registry entry, value of a two-token --db",
  },
  "lib/workspace-health.ts::tryAutoRecoverDolt::execFileAsync": {
    count: 2,
    why: "fixed argv (dolt start / list --json --limit 1); --db is derived from the registry entry, value of a two-token --db",
  },

  // --- not bd ---
  "handlers/system.ts::openInFileManager::execFile": {
    count: 1,
    why: "open / explorer.exe / xdg-open with path.resolve(dirPath): an absolute path cannot start with '-', and existsSync is checked first",
  },
  "index.ts::captureShutdownSource::Bun.spawnSync": {
    count: 2,
    why: "ps / pgrep diagnostics with fixed args and our own pids; no input",
  },
  "index.ts::shutdown::Bun.spawn": {
    count: 1,
    why: "/bin/sh watchdog interpolating only our pid and the Node signal name we received; no client input",
  },
  "lib/parent-death-watcher.ts::startParentDeathWatcherViaShell::Bun.spawn": {
    count: 1,
    why: "/bin/sh or powershell loop interpolating only numeric pids, a numeric interval and a signal name; no client input",
  },
}

// Text-level backstop. The walker models spawner forms one by one; a form it
// does not model would leave the census green. So independently of the
// walker: every source file whose CODE (comments stripped) mentions anything
// spawn-shaped must contribute at least one census entry, or be listed here
// with a reason. A new evasive form therefore fails loudly, naming the file,
// even before the walker learns it.
const SPAWN_TEXT =
  /child_process|["']bun["']|\bBun\b|\bspawn(Sync)?\b|\bexecFile(Sync)?\b|\bexeca\b|cross-spawn|tinyexec|\bzx\b|process\.binding|\brequire\s*\(/
const BACKSTOP_REVIEWED: Record<string, string> = {
  "lib/exec.ts":
    "defines execFileAsync = promisify(execFile) and the PATH it runs with; it calls nothing itself, and its spawner is followed to every call site",
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

const CHILD_PROCESS = new Set(["child_process", "node:child_process"])
const CHILD_PROCESS_SPAWNERS = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
])
const BUN = new Set(["bun"])
const BUN_SPAWNERS = new Set(["spawn", "spawnSync", "$"])

type Sources = Record<string, string> // relative path -> source text

function parse(sources: Sources): Record<string, ts.SourceFile> {
  return Object.fromEntries(
    Object.entries(sources).map(([p, text]) => [
      p,
      ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true),
    ]),
  )
}

function resolveImport(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith(".")) return null
  const base = relative("/", resolve("/", dirname(from), spec))
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (files.has(candidate)) return candidate
  }
  return null
}

interface FileBindings {
  locals: Set<string> // local identifiers that spawn when called
  cp: Set<string> // local names bound to the child_process module object
  bun: Set<string> // local names bound to the Bun object (always includes the global)
}

type Namespace = "cp" | "bun"

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

/** "cp" / "bun" when the expression evaluates to a spawner-bearing module object. */
function namespaceOf(expr: ts.Expression, b: FileBindings): Namespace | null {
  const e = unwrap(expr)
  if (ts.isIdentifier(e)) {
    if (b.cp.has(e.text)) return "cp"
    if (b.bun.has(e.text)) return "bun"
    return null
  }
  // require("child_process") / require("bun")
  if (
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "require" &&
    e.arguments.length === 1 &&
    ts.isStringLiteral(e.arguments[0])
  ) {
    const spec = e.arguments[0].text
    if (CHILD_PROCESS.has(spec)) return "cp"
    if (BUN.has(spec)) return "bun"
  }
  return null
}

function spawnerMember(ns: Namespace, member: string): boolean {
  return ns === "cp" ? CHILD_PROCESS_SPAWNERS.has(member) : BUN_SPAWNERS.has(member)
}

/** Local spawner bindings per file, iterated to a fixed point across re-exports. */
function spawnerBindings(sfs: Record<string, ts.SourceFile>): Record<string, FileBindings> {
  const files = new Set(Object.keys(sfs))
  const bindings: Record<string, FileBindings> = {}
  const exported: Record<string, Set<string>> = {}
  for (const f of files) {
    bindings[f] = { locals: new Set(), cp: new Set(), bun: new Set(["Bun"]) }
    exported[f] = new Set()
  }

  let changed = true
  while (changed) {
    changed = false
    const add = (set: Set<string>, name: string) => {
      if (!set.has(name)) {
        set.add(name)
        changed = true
      }
    }
    for (const [f, sf] of Object.entries(sfs)) {
      const b = bindings[f]
      for (const stmt of sf.statements) {
        if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const spec = stmt.moduleSpecifier.text
          const clause = stmt.importClause
          if (!clause) continue
          const ns: Namespace | null = CHILD_PROCESS.has(spec) ? "cp" : BUN.has(spec) ? "bun" : null
          if (ns) {
            // Default import binds the module object, same as a namespace import.
            if (clause.name) add(b[ns], clause.name.text)
            const nb = clause.namedBindings
            if (nb && ts.isNamespaceImport(nb)) add(b[ns], nb.name.text)
            if (nb && ts.isNamedImports(nb)) {
              for (const el of nb.elements) {
                if (spawnerMember(ns, (el.propertyName ?? el.name).text))
                  add(b.locals, el.name.text)
              }
            }
            continue
          }
          if (!clause.namedBindings) continue
          const target = resolveImport(f, spec, files)
          if (!target || !ts.isNamedImports(clause.namedBindings)) continue
          for (const el of clause.namedBindings.elements) {
            const imported = (el.propertyName ?? el.name).text
            if (exported[target].has(imported)) add(b.locals, el.name.text)
          }
        }
      }
      // Aliases, destructures and wrappers, anywhere in the file:
      //   const sp = Bun.spawn / cp.execFile / other     -> spawner
      //   const run = promisify(execFile) / x.bind(...)   -> spawner
      //   const B = Bun / const cp = require("child_process") -> module object
      //   const { spawn } = Bun / const { execFile: e } = cp  -> spawner
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
          const init = unwrap(node.initializer)
          const ns = namespaceOf(init, b)
          if (ts.isIdentifier(node.name)) {
            if (ns) add(b[ns], node.name.text)
            else if (isSpawnerExpr(init, b) || wrapsSpawner(init, b)) add(b.locals, node.name.text)
          } else if (ts.isObjectBindingPattern(node.name) && ns) {
            for (const el of node.name.elements) {
              const key = el.propertyName ?? el.name
              if (ts.isIdentifier(key) && ts.isIdentifier(el.name) && spawnerMember(ns, key.text)) {
                add(b.locals, el.name.text)
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
      // Exports of spawner bindings (export const x = ..., export { x }).
      for (const stmt of sf.statements) {
        const isExported = ts
          .getModifiers(stmt as ts.HasModifiers)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        if (isExported && ts.isVariableStatement(stmt)) {
          for (const d of stmt.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && b.locals.has(d.name.text)) {
              add(exported[f], d.name.text)
            }
          }
        }
        if (
          ts.isExportDeclaration(stmt) &&
          stmt.exportClause &&
          ts.isNamedExports(stmt.exportClause)
        ) {
          for (const el of stmt.exportClause.elements) {
            const local = (el.propertyName ?? el.name).text
            if (b.locals.has(local)) add(exported[f], el.name.text)
          }
        }
      }
    }
  }
  return bindings
}

/** The expression IS a spawner: a bound local, ns.spawner, ns["spawner"], or spawner.call/apply. */
function isSpawnerExpr(expr: ts.Expression, b: FileBindings): boolean {
  const e = unwrap(expr)
  if (ts.isIdentifier(e)) return b.locals.has(e.text)
  if (ts.isPropertyAccessExpression(e)) {
    const ns = namespaceOf(e.expression, b)
    if (ns) return spawnerMember(ns, e.name.text)
    // spawner.call(...) / spawner.apply(...)
    return (e.name.text === "call" || e.name.text === "apply") && isSpawnerExpr(e.expression, b)
  }
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    const ns = namespaceOf(e.expression, b)
    return ns !== null && spawnerMember(ns, e.argumentExpression.text)
  }
  return false
}

/** promisify(<spawner>) or <spawner>.bind(...): a new function that spawns. */
function wrapsSpawner(expr: ts.Expression, b: FileBindings): boolean {
  const e = unwrap(expr)
  if (!ts.isCallExpression(e)) return false
  const callee = unwrap(e.expression)
  const isPromisify =
    (ts.isIdentifier(callee) && callee.text === "promisify") ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "promisify")
  if (isPromisify) return e.arguments.length > 0 && isSpawnerExpr(e.arguments[0], b)
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "bind" &&
    isSpawnerExpr(callee.expression, b)
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

/** Every spawn call: "<file>::<enclosing chain>::<spawner as written>" -> count. */
function census(sources: Sources): Record<string, number> {
  const sfs = parse(sources)
  const bindings = spawnerBindings(sfs)
  const found: Record<string, number> = {}
  for (const [f, sf] of Object.entries(sfs)) {
    const b = bindings[f]
    const visit = (node: ts.Node) => {
      const callee = ts.isCallExpression(node)
        ? node.expression
        : ts.isTaggedTemplateExpression(node)
          ? node.tag
          : null
      if (callee && isSpawnerExpr(callee, b)) {
        const key = `${f}::${enclosingChain(node)}::${callee.getText(sf)}`
        found[key] = (found[key] ?? 0) + 1
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return found
}

/** Files whose comment-stripped code mentions a spawn-shaped name. */
function spawnShapedFiles(sources: Sources): string[] {
  const printer = ts.createPrinter({ removeComments: true })
  return Object.entries(sources)
    .filter(([p, text]) => {
      const code = printer.printFile(ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true))
      return SPAWN_TEXT.test(code)
    })
    .map(([p]) => p)
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

describe("census walker sees every spawner form (so it cannot pass by not looking)", () => {
  const found = census({
    "lib/exec.ts": [
      `import { execFile as ef } from "node:child_process"`,
      `import { promisify } from "node:util"`,
      `export const runIt = promisify(ef)`,
    ].join("\n"),
    "lib/reexport.ts": [`import { runIt } from "./exec"`, `export { runIt as again }`].join("\n"),
    "handlers/a.ts": [
      `import * as cp from "child_process"`,
      `import { runIt as r } from "../lib/exec"`,
      `import { again } from "../lib/reexport"`,
      `function viaNamespace() { cp.spawn("bd", []) }`,
      `const viaImportAlias = async () => { await r("bd", []) }`,
      `function viaReexport() { again("bd", []) }`,
      `function viaBun() { Bun.spawn(["bd"]); Bun.$\`bd list\` }`,
      `function notASpawn() { spawn("bd") }`,
    ].join("\n"),
    // The three forms sec's probe used to evade the first version (beadbox-c29 S1).
    "lib/sec-default.ts": [
      `import cp from "node:child_process"`,
      `function viaDefaultImport() { cp.execFile("bd", []) }`,
    ].join("\n"),
    "lib/sec-bun-dollar.ts": [
      `import { $ } from "bun"`,
      `async function viaBunDollarImport() { await $\`bd list\` }`,
    ].join("\n"),
    "lib/sec-alias.ts": [`const sp = Bun.spawn`, `function viaBunAlias() { sp(["bd"]) }`].join(
      "\n",
    ),
    // Neighbouring forms of the same kind.
    "lib/more.ts": [
      `import * as B from "bun"`,
      `const cpr = require("child_process")`,
      `const { spawn: s } = Bun`,
      `const { execFile: ef } = cpr`,
      `const Bn = Bun`,
      `const bound = Bun.spawnSync.bind(Bun)`,
      `function viaBunNamespace() { B.spawn(["bd"]) }`,
      `function viaRequire() { cpr.spawn("bd", []) }`,
      `function viaDestructure() { s(["bd"]); ef("bd", []) }`,
      `function viaReassignedBun() { Bn["spawn"](["bd"]) }`,
      `function viaBindCall() { bound(["bd"]); Bun.spawn.call(Bun, ["bd"]) }`,
      `function notSpawns() { Bun.file("x"); B.env; cpr.ChildProcess }`,
    ].join("\n"),
  })

  test("aliased import, namespace, promisify, cross-module re-export, Bun.spawn and Bun.$", () => {
    expect(
      Object.keys(found)
        .filter((k) => !k.startsWith("lib/"))
        .sort(),
    ).toEqual(
      [
        "handlers/a.ts::viaBun::Bun.$",
        "handlers/a.ts::viaBun::Bun.spawn",
        "handlers/a.ts::viaImportAlias::r",
        "handlers/a.ts::viaNamespace::cp.spawn",
        "handlers/a.ts::viaReexport::again",
      ].sort(),
    )
  })

  test("default import, named import from bun, and an alias of Bun.spawn (sec's probe forms)", () => {
    expect(
      Object.keys(found)
        .filter((k) => k.startsWith("lib/sec-"))
        .sort(),
    ).toEqual(
      [
        "lib/sec-alias.ts::viaBunAlias::sp",
        "lib/sec-bun-dollar.ts::viaBunDollarImport::$",
        "lib/sec-default.ts::viaDefaultImport::cp.execFile",
      ].sort(),
    )
  })

  test("bun namespace, require, destructures, a reassigned Bun, bind and call", () => {
    expect(
      Object.keys(found)
        .filter((k) => k.startsWith("lib/more.ts"))
        .sort(),
    ).toEqual(
      [
        "lib/more.ts::viaBindCall::Bun.spawn.call",
        "lib/more.ts::viaBindCall::bound",
        "lib/more.ts::viaBunNamespace::B.spawn",
        "lib/more.ts::viaDestructure::ef",
        "lib/more.ts::viaDestructure::s",
        "lib/more.ts::viaRequire::cpr.spawn",
        'lib/more.ts::viaReassignedBun::Bn["spawn"]',
      ].sort(),
    )
  })
})

describe("text-level backstop catches forms the walker does not model", () => {
  test("a file with spawn-shaped code and no census entry is reported", () => {
    const sources = {
      // Computed member name: invisible to the walker by construction.
      "lib/evasive.ts": `export function x() { const k = "spa" + "wn"; (Bun as any)[k](["bd"]) }`,
      // Comments are stripped first, so prose about Bun.spawn is not a spawn.
      "lib/prose.ts": `// uses Bun.spawn and child_process elsewhere\nexport const y = 1`,
    }
    const found = census(sources)
    const covered = new Set(Object.keys(found).map((k) => k.split("::")[0]))
    expect(Object.keys(found)).toEqual([])
    expect(spawnShapedFiles(sources).filter((f) => !covered.has(f))).toEqual(["lib/evasive.ts"])
  })
})

describe("process-spawn census of packages/server", () => {
  const found = census(serverSources())

  test("the census found spawn sites (a walker that finds nothing is broken)", () => {
    expect(Object.keys(found).length).toBeGreaterThan(10)
  })

  test("every spawn site is reviewed, and every reviewed entry still exists", () => {
    const actual = Object.entries(found)
      .map(([k, n]) => `${k} x${n}`)
      .sort()
    const expected = Object.entries(REVIEWED)
      .map(([k, v]) => `${k} x${v.count}`)
      .sort()
    expect(actual).toEqual(expected)
  })

  test("backstop: every file with spawn-shaped code has a census entry or a reviewed reason", () => {
    const sources = serverSources()
    const covered = new Set(Object.keys(found).map((k) => k.split("::")[0]))
    const shaped = spawnShapedFiles(sources)
    const uncovered = shaped.filter((f) => !covered.has(f) && !(f in BACKSTOP_REVIEWED))
    expect(uncovered).toEqual([])
    // An exemption must still be needed: its file is spawn-shaped and uncovered.
    const stale = Object.keys(BACKSTOP_REVIEWED).filter(
      (f) => !shaped.includes(f) || covered.has(f),
    )
    expect(stale).toEqual([])
    expect(shaped.length).toBeGreaterThan(5)
  })

  test("every reviewed entry states why its argv is safe", () => {
    expect(Object.entries(REVIEWED).filter(([, v]) => v.why.trim().length < 20)).toEqual([])
  })
})
