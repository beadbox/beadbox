// Mechanical argv-injection coverage for every exported function of lib/bd.ts
// (beadbox-c29).
//
// bd is a cobra/pflag CLI: any argv token starting with "-" is lexed as a flag
// wherever it came from, so a client string that lands in argv as its own
// token can retarget --db (see lib/bd-argv.ts). The previous call-site test
// named nine functions by hand and could not fail for a function it did not
// name. This one derives its subject list from the source:
//
//   1. The TypeScript checker enumerates every exported function of lib/bd.ts
//      and the type of every parameter. The list is cross-checked against the
//      runtime module, so the enumerator cannot silently miss an export.
//   2. Every string-bearing slot (string, string-literal unions, string[]
//      elements, Record keys and values, string fields of object params) is a
//      "slot". Runtime RPC does not enforce TS unions, so unions count.
//   3. Each slot is fuzzed on its own — hostile token in that slot, benign
//      values everywhere else — so a guard on one argument cannot mask an
//      unguarded sibling. bd is a fake on BD_PATH that records its argv.
//   4. Each run is classified (see classify()). Anything that is not
//      positively safe fails the test: a slot we could not observe is not a
//      pass.
//
// Out of scope by declaration: BdOptions (options.db is validated at the
// handler boundary by isValidWorkspaceDir and enters argv only as the value of
// a two-token --db). Direct spawns outside lib/bd.ts are covered by the census
// in bd-spawn-census.security.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as ts from "typescript"
import * as bd from "../lib/bd"
import { BdArgvError } from "../lib/bd-argv"

const HOSTILE = "--db=/tmp/c29-evil"
const BENIGN = "bb-1"
const OPTIONS_TYPE = "BdOptions"
const CALL_TIMEOUT_MS = 5_000

const BD_SOURCE = join(dirname(import.meta.dir), "lib", "bd.ts")

// Exports that never spawn bd. Each run of a NO_BD function is asserted to
// record zero bd invocations, so a helper that grows a spawn fails here and
// has to be reclassified.
const NO_BD: Record<string, string> = {
  __resetBdVersionCache: "cache reset",
  __resetDbLocks: "cache reset",
  __resetBdPathCache: "cache reset",
  getBdPath: "resolves a path; spawns nothing",
  stripBdWarnings: "string filter over bd's stderr",
  parseBdJson: "JSON parser over bd's stdout",
  setWorkspacePassword: "in-memory credential map",
  clearWorkspacePassword: "in-memory credential map",
  getWorkspacePassword: "in-memory credential map",
  isEmbeddedMode: "reads metadata.json",
  getEmbeddedFingerprint: "hashes the Dolt manifest file",
  buildServerEnv: "builds an env object",
  tryReadJson: "reads a file",
  readMetadataServerKey: "reads metadata.json",
  resolveLocalDbPassword: "reads the credential map",
  resolveDoltPortOverride: "reads dolt-server.port",
  mapType: "value mapping",
  mapPriority: "value mapping",
  unmapPriority: "value mapping",
  durationToISODate: "date arithmetic",
  discoverServerDatabases: "talks to the Dolt server over mysql2; never spawns bd",
}

// ---------------------------------------------------------------------------
// Enumeration (TypeScript checker)
// ---------------------------------------------------------------------------

type Shape =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "options" }
  | { kind: "array"; element: Shape }
  | { kind: "record"; value: Shape }
  | { kind: "object"; props: Array<[string, Shape]> }
  | { kind: "unsynthesizable"; text: string }

interface ExportedFn {
  name: string
  params: Array<{ name: string; shape: Shape }>
}

function enumerateExports(): ExportedFn[] {
  const root = dirname(dirname(import.meta.dir))
  const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")
  if (!cfgPath) throw new Error("tsconfig.json not found for packages/server")
  const cfg = ts.parseJsonConfigFileContent(
    ts.readConfigFile(cfgPath, ts.sys.readFile).config,
    ts.sys,
    root,
  )
  // Pin module/type resolution to the package root so the result does not
  // depend on the directory the test runner was started from.
  const host = ts.createCompilerHost(cfg.options)
  host.getCurrentDirectory = () => root
  const program = ts.createProgram([BD_SOURCE], cfg.options, host)
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(BD_SOURCE)
  if (!sf) throw new Error(`cannot load ${BD_SOURCE}`)
  const moduleSymbol = checker.getSymbolAtLocation(sf)
  if (!moduleSymbol) throw new Error("lib/bd.ts has no module symbol")

  const shapeOf = (type: ts.Type, depth: number): Shape => {
    const t = checker.getNonNullableType(type)
    const text = checker.typeToString(t)
    if (depth > 4) return { kind: "unsynthesizable", text }
    if (t.aliasSymbol?.getName() === OPTIONS_TYPE || text === OPTIONS_TYPE) {
      return { kind: "options" }
    }
    const members = t.isUnion() ? t.types : [t]
    if (members.some((m) => m.flags & ts.TypeFlags.StringLike)) return { kind: "string" }
    if (members.every((m) => m.flags & ts.TypeFlags.NumberLike)) return { kind: "number" }
    if (members.every((m) => m.flags & ts.TypeFlags.BooleanLike)) return { kind: "boolean" }
    if (checker.isArrayType(t)) {
      const [element] = checker.getTypeArguments(t as ts.TypeReference)
      return { kind: "array", element: shapeOf(element, depth + 1) }
    }
    const stringIndex = checker.getIndexInfosOfType(t).find((info) => {
      return info.keyType.flags & ts.TypeFlags.String
    })
    if (stringIndex) return { kind: "record", value: shapeOf(stringIndex.type, depth + 1) }
    if (t.flags & ts.TypeFlags.Object && t.getCallSignatures().length === 0) {
      const props = checker.getPropertiesOfType(t).map((p): [string, Shape] => {
        return [p.getName(), shapeOf(checker.getTypeOfSymbolAtLocation(p, sf), depth + 1)]
      })
      return { kind: "object", props }
    }
    return { kind: "unsynthesizable", text }
  }

  const out: ExportedFn[] = []
  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    const resolved = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
    const type = checker.getTypeOfSymbolAtLocation(resolved, sf)
    const [sig] = type.getCallSignatures()
    if (!sig) continue
    out.push({
      name: sym.getName(),
      params: sig.getParameters().map((p) => ({
        name: p.getName(),
        shape: shapeOf(checker.getTypeOfSymbolAtLocation(p, sf), 0),
      })),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Slots and argument synthesis
// ---------------------------------------------------------------------------

/** Every string-bearing position in a shape, as a path ("vars{key}", "server.host"). */
function slotsOf(shape: Shape, path: string): string[] {
  switch (shape.kind) {
    case "string":
      return [path]
    case "array":
      return slotsOf(shape.element, `${path}[0]`)
    case "record":
      return [`${path}{key}`, ...slotsOf(shape.value, `${path}{value}`)]
    case "object":
      return shape.props.flatMap(([k, s]) => slotsOf(s, `${path}.${k}`))
    default:
      return []
  }
}

function build(shape: Shape, path: string, hostileSlot: string, db: string): unknown {
  const str = (p: string) => (p === hostileSlot ? HOSTILE : BENIGN)
  switch (shape.kind) {
    case "string":
      return str(path)
    case "number":
      return 1
    case "boolean":
      return false
    case "options":
      return { db }
    case "array":
      return [build(shape.element, `${path}[0]`, hostileSlot, db)]
    case "record":
      return { [str(`${path}{key}`)]: build(shape.value, `${path}{value}`, hostileSlot, db) }
    case "object":
      return Object.fromEntries(
        shape.props.map(([k, s]) => [k, build(s, `${path}.${k}`, hostileSlot, db)]),
      )
    case "unsynthesizable":
      throw new Error(`cannot synthesize a value of type ${shape.text}`)
  }
}

// ---------------------------------------------------------------------------
// Fake bd and classification
// ---------------------------------------------------------------------------

let root: string
let db: string
let argvLog: string
const originalBdPath = process.env.BD_PATH
const originalRegistry = process.env.BEADBOX_REGISTRY_PATH
const originalLegacyRegistry = process.env.BEADS_REGISTRY_PATH
const originalCwd = process.cwd()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "beadbox-c29-"))
  db = join(root, "proj", ".beads")
  await mkdir(db, { recursive: true })
  await writeFile(join(db, "metadata.json"), JSON.stringify({ dolt_mode: "embedded" }))
  argvLog = join(root, "argv.log")
  const fakeBd = join(root, "bd")
  // One record per invocation: tokens separated by \037, records by \036.
  await writeFile(
    fakeBd,
    `#!/bin/sh\nprintf '%s\\037' "$@" >> "${argvLog}"\nprintf '\\036' >> "${argvLog}"\necho '[]'\n`,
    { mode: 0o700 },
  )
  process.env.BD_PATH = fakeBd
  // Path-typed parameters (initWorkspace's path, initServerScaffold's cwd) are
  // resolved relative to the process cwd. Run from a directory where both the
  // benign and the hostile value exist as directories, so the spawn happens and
  // the slot is observed instead of failing on a missing cwd.
  // The cwd is the scaffold root, so initServerScaffold's containment guard
  // (beadbox-287) accepts a benign relative dir and every other slot is
  // observed, while a hostile scaffoldDir is refused before any spawn. Both
  // registries point at scratch so no export reads the real ones.
  // realpath: on macOS the temp dir is /var/..., a symlink to /private/var/...,
  // and after chdir the process cwd (which resolves the relative dir) is the
  // real path. A registry named through the symlink would refuse every dir.
  const realRoot = realpathSync(root)
  process.env.BEADBOX_REGISTRY_PATH = join(realRoot, "registry.json")
  process.env.BEADS_REGISTRY_PATH = join(realRoot, "legacy-registry.json")
  const cwd = join(root, "workspaces")
  await mkdir(join(cwd, BENIGN), { recursive: true })
  await mkdir(join(cwd, HOSTILE), { recursive: true })
  process.chdir(cwd)
})

afterAll(async () => {
  process.chdir(originalCwd)
  if (originalBdPath === undefined) delete process.env.BD_PATH
  else process.env.BD_PATH = originalBdPath
  if (originalRegistry === undefined) delete process.env.BEADBOX_REGISTRY_PATH
  else process.env.BEADBOX_REGISTRY_PATH = originalRegistry
  if (originalLegacyRegistry === undefined) delete process.env.BEADS_REGISTRY_PATH
  else process.env.BEADS_REGISTRY_PATH = originalLegacyRegistry
  bd.__resetBdPathCache()
  await rm(root, { recursive: true, force: true })
})

async function readInvocations(): Promise<string[][]> {
  const raw = await readFile(argvLog, "utf-8").catch(() => "")
  return raw
    .split("\x1e")
    .filter((rec) => rec.length > 0)
    .map((rec) => rec.split("\x1f").slice(0, -1))
}

/** A token is unsafe when the hostile value occupies a flag-lexing position. */
function unsafeTokens(argv: string[]): string[] {
  const terminator = argv.indexOf("--")
  return argv.filter((tok, i) => {
    const beforeTerminator = terminator === -1 || i < terminator
    return beforeTerminator && tok.startsWith(HOSTILE)
  })
}

type Verdict =
  | "GUARDED" // BdArgvError, zero spawns
  | "SAFE" // hostile reached argv, contained (--flag=value or after "--")
  | "SAFE-ABSENT" // call completed; hostile never entered argv (env, cwd, filter)
  | "UNSAFE" // hostile is its own flag-position token
  | "INCONCLUSIVE" // could not observe the slot: no spawn, or errored before it

interface RunResult {
  fn: string
  slot: string
  verdict: Verdict
  detail: string
  spawns: number
}

async function runSlot(fn: ExportedFn, slot: string): Promise<RunResult> {
  await writeFile(argvLog, "")
  bd.__resetBdPathCache()
  bd.__resetBdVersionCache()
  bd.__resetDbLocks()

  const args = fn.params.map((p) => build(p.shape, p.name, slot, db))
  const target = (bd as Record<string, unknown>)[fn.name] as (...a: unknown[]) => unknown
  let error: unknown = null
  try {
    await Promise.race([
      Promise.resolve().then(() => target(...args)),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), CALL_TIMEOUT_MS)
      }),
    ])
  } catch (err) {
    error = err
  }

  const invocations = await readInvocations()
  const unsafe = invocations.flatMap(unsafeTokens)
  const reached = invocations.some((argv) => argv.some((tok) => tok.includes(HOSTILE)))
  const argvText = invocations.map((a) => `bd ${a.join(" ")}`).join(" | ")
  const errText = error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  let verdict: Verdict
  let detail: string
  if (unsafe.length > 0) {
    verdict = "UNSAFE"
    detail = argvText
  } else if (error instanceof BdArgvError && invocations.length === 0) {
    verdict = "GUARDED"
    detail = error.message
  } else if (reached) {
    verdict = "SAFE"
    detail = argvText
  } else if (error === null) {
    verdict = "SAFE-ABSENT"
    detail = invocations.length === 0 ? "no spawn" : argvText
  } else {
    verdict = "INCONCLUSIVE"
    detail = `${errText}${invocations.length ? ` after ${argvText}` : " before any spawn"}`
  }
  return { fn: fn.name, slot, verdict, detail, spawns: invocations.length }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const exported = enumerateExports()

describe("enumeration", () => {
  test("the checker's export list is exactly the module's runtime functions", () => {
    const fromChecker = exported.map((f) => f.name).sort()
    const fromRuntime = Object.entries(bd)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort()
    expect(fromChecker).toEqual(fromRuntime)
  })

  test("every parameter type is synthesizable", () => {
    const bad = exported.flatMap((f) =>
      f.params
        .filter((p) => JSON.stringify(p.shape).includes("unsynthesizable"))
        .map((p) => `${f.name}(${p.name}: ${JSON.stringify(p.shape)})`),
    )
    expect(bad).toEqual([])
  })

  test("the NO_BD list names only real exports", () => {
    const names = new Set(exported.map((f) => f.name))
    expect(Object.keys(NO_BD).filter((n) => !names.has(n))).toEqual([])
  })
})

describe("every string-bearing slot of every lib/bd.ts export is kept out of flag position", () => {
  const cases = exported.flatMap((fn) =>
    fn.params.flatMap((p) => slotsOf(p.shape, p.name)).map((slot) => ({ fn, slot })),
  )

  test("enumeration found slots to test", () => {
    expect(cases.length).toBeGreaterThan(50)
  })

  test("no slot reaches bd as a flag, and every slot was observed", async () => {
    const results: RunResult[] = []
    for (const { fn, slot } of cases) results.push(await runSlot(fn, slot))

    // State what was examined: a clean result over zero observations is not a pass.
    const tally: Record<string, number> = {}
    for (const r of results) {
      const key =
        NO_BD[r.fn] !== undefined ? `NO_BD(${r.spawns ? "SPAWNED" : "0 spawns"})` : r.verdict
      tally[key] = (tally[key] ?? 0) + 1
    }
    const fns = new Set(results.map((r) => r.fn)).size
    console.log(
      `[c29] ${exported.length} exports, ${fns} with string slots, ${results.length} slots: ${JSON.stringify(tally)}`,
    )

    const failures = results.filter((r) => {
      if (NO_BD[r.fn] !== undefined) {
        // A pure helper must never spawn, whatever it is given.
        return r.spawns > 0
      }
      return r.verdict === "UNSAFE" || r.verdict === "INCONCLUSIVE"
    })
    const report = failures.map((r) => {
      const tag = NO_BD[r.fn] !== undefined ? "NO_BD-SPAWNED" : r.verdict
      return `${tag.padEnd(12)} ${r.fn}(${r.slot})  ${r.detail}`
    })
    expect(report).toEqual([])
  }, 120_000)
})
