// Census for the Commands-tab redaction list (beadbox-hqtp).
//
// REDACTED_ARG_METHODS is the policy; this test proves it complete. It reads
// the sidecar's handler sources, finds every exported handler whose parameter
// list mentions a password-like word (names, destructured fields and inline
// types alike), and fails if one is not listed. A new credential-carrying
// handler therefore cannot reach the tap unredacted by accident.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REDACTED_ARG_METHODS } from "../lib/rpc"

const HANDLERS_DIR = join(import.meta.dir, "../../../server/src/handlers")
const CREDENTIAL_WORD = /password|passphrase|secret|token/i

// The five known today (arch verdict on beadbox-hqtp). The scan must find all
// of them, so a broken or empty scan cannot pass as "nothing to list".
const KNOWN = [
  "workspaces.discoverServerDatabases",
  "workspaces.addServerWorkspace",
  "workspaces.setServerPassword",
  "workspaces.replaceLocalWithServer",
  "workspaces.updateServerConnection",
]

/** namespace key in `handlers` -> handler source file, read from handlers/index.ts. */
function namespaceFiles(): Map<string, string> {
  const index = readFileSync(join(HANDLERS_DIR, "index.ts"), "utf8")
  const aliasToFile = new Map<string, string>()
  for (const m of index.matchAll(/^import \* as (\w+) from "\.\/([\w-]+)"/gm)) {
    aliasToFile.set(m[1], `${m[2]}.ts`)
  }
  const block = index.slice(index.indexOf("export const handlers = {"))
  const body = block.slice(0, block.indexOf("} as const"))
  const out = new Map<string, string>()
  for (const m of body.matchAll(/^\s*(\w+)(?::\s*wrapNamespace\((\w+),[^)]*\))?,\s*$/gm)) {
    const file = aliasToFile.get(m[2] ?? m[1])
    if (file) out.set(m[1], file)
  }
  return out
}

/** Text between the "(" at `open` and its matching ")", skipping string literals. */
function parenBody(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") {
      i = src.indexOf(c, i + 1)
      if (i < 0) break
      continue
    }
    if (c === "(") depth++
    if (c === ")" && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error(`unbalanced parameter list at offset ${open}`)
}

/** Parameter-list text of each function a handler file exports, by export name. */
function exportedSignatures(src: string, file: string): Map<string, string> {
  if (/^export \*|^export \{[^}]*\} from/m.test(src)) {
    throw new Error(`${file}: re-exports from another module; extend the census to follow them`)
  }
  const declOpen = (name: string, exported: boolean): number | null => {
    const prefix = exported ? "export\\s+" : "(?:^|\\n)\\s*"
    const re = new RegExp(
      `${prefix}(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*(?:<[^(]*>)?\\(|` +
        `${prefix}const\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\s*\\w*\\s*)?\\(`,
    )
    const m = re.exec(src)
    return m ? m.index + m[0].length - 1 : null
  }
  const out = new Map<string, string>()
  const names = new Set<string>()
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*(\w+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s+const\s+(\w+)/g)) names.add(m[1])
  for (const name of names) {
    const open = declOpen(name, true)
    if (open !== null) out.set(name, parenBody(src, open))
  }
  // Local `export { a, b }`: follow each name to its declaration.
  for (const m of src.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const raw of m[1].split(",")) {
      const [local, exported = local] = raw.trim().split(/\s+as\s+/)
      if (!local) continue
      const open = declOpen(local, false)
      if (open !== null) out.set(exported, parenBody(src, open))
    }
  }
  return out
}

function credentialMethods(): string[] {
  const found: string[] = []
  for (const [ns, file] of namespaceFiles()) {
    const src = readFileSync(join(HANDLERS_DIR, file), "utf8")
    for (const [name, params] of exportedSignatures(src, file)) {
      if (CREDENTIAL_WORD.test(params)) found.push(`${ns}.${name}`)
    }
  }
  return found.sort()
}

describe("Commands-tab redaction census", () => {
  test("the scan reads every handler namespace", () => {
    const files = namespaceFiles()
    expect(files.size).toBe(16)
    expect(files.get("workspaces")).toBe("workspaces.ts")
    expect(files.get("subscribe")).toBe("subscribe.ts")
  })

  test("the scan finds the five known credential-carrying handlers", () => {
    expect(credentialMethods()).toEqual(expect.arrayContaining(KNOWN))
  })

  test("every handler taking a password-like parameter is in REDACTED_ARG_METHODS", () => {
    const unlisted = credentialMethods().filter((m) => !REDACTED_ARG_METHODS.has(m))
    expect(unlisted).toEqual([])
  })

  test("the scanner flags a password in a name, a destructured field and an inline type", () => {
    const src = [
      "export async function a(host: string, password?: string) {}",
      "export function b({ user, password }: Opts) {}",
      'export const c = async (id: string, opts: { token: string } = { token: "(" }) => {}',
      "async function d(secret: string) {}",
      "export { d as e }",
      "export async function f(host: string, port: number) {}",
    ].join("\n")
    const sigs = exportedSignatures(src, "fixture.ts")
    const flagged = [...sigs].filter(([, p]) => CREDENTIAL_WORD.test(p)).map(([n]) => n)
    expect(flagged.sort()).toEqual(["a", "b", "c", "e"])
    expect(sigs.has("f")).toBe(true)
  })
})
