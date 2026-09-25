// Dev console kkrpc handler — port of app/api/bd/route.ts (P3.6 / bb-90zz.6).
//
// Security contract (preserved from the Next.js source):
//   1. Two-level allowlist — args[0] must be one of ALLOWED_COMMANDS, and for
//      commands that carry mutating subcommands (dep, config, comments) the
//      subcommand is gated too (see ALLOWED_SUBCOMMANDS below). The dev
//      console is for inspection, not mutation; mutation paths flow through
//      the typed rpc.{beads,epics,...} handlers with their own validation.
//   2. Argv shell-metachar rejection — any arg matching the regex
//      /[;&|`$(){}]/ is rejected. execFile() does not invoke a shell, but the
//      reject is defence-in-depth in case bd ever shells out internally.
//   3. --db is forbidden in user args — callers must pass the db path via the
//      `db` parameter so isValidDbPath gates the path through the same check
//      lib/path-validation.ts uses elsewhere.
//   4. The HTTP-bound session-token check from app/api/console/route.ts is
//      DROPPED here. kkrpc rides the Tauri process boundary; there is no
//      public HTTP endpoint for an attacker to hit, so the boundary IS the
//      authentication — but only as long as nothing else can cross it.
//      What actually enforces that is src-tauri/capabilities/default.json:
//      it grants IPC to no remote origin, so only the app's own bundle can
//      reach rpc.console.run. That file used to grant IPC to
//      http://127.0.0.1:*/* and http://localhost:*/*, which meant any page on
//      any local port could call this handler; removed in beadbox-l5i.3 and
//      pinned by __tests__/tauri-config.security.test.ts. Re-adding a remote
//      grant re-opens this endpoint, so treat that file as part of this
//      module's security contract.

import { resolveBdPath } from "../lib/bd-paths"
import { buildEnv } from "../lib/bd"
import { execFileAsync } from "../lib/exec"
import { isValidDbPath } from "../lib/path-validation"

export const ALLOWED_COMMANDS = [
  "show",
  "list",
  "comments",
  "dep",
  "search",
  "config",
  "help",
] as const

// beadbox-l5i.3: the top-level allowlist alone did NOT deliver the read-only
// guarantee this module claims. Three of the seven commands carry mutating
// subcommands (bd 1.0.5):
//
//   bd dep add|remove|relate|unrelate     -> edits the dependency graph
//   bd config set|set-many|unset|apply    -> rewrites workspace config
//   bd comments add                       -> writes a comment
//
// For dep/config the subcommand is args[1] and can be allowlisted positively.
// `bd comments` is different: args[1] is an ISSUE ID, not a subcommand, so
// there is no positive list to match against — "add" is refused by name
// wherever it appears instead.
const ALLOWED_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  dep: ["list", "tree", "cycles"],
  config: ["get", "list", "show", "drift", "validate"],
})

const MUTATING_SUBCOMMAND_ANYWHERE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  comments: ["add"],
})

const SHELL_META = /[;&|`$(){}]/
const EXEC_TIMEOUT_MS = 10_000

export interface ConsoleRunArgs {
  args: string[]
  db?: string | null
}

export interface ConsoleRunResult {
  stdout: string
  stderr: string
  exitCode: number
  // When the call is rejected at the validation gate (allowlist, shell meta,
  // --db, invalid path) error is set and exitCode is 1. When execFile runs
  // and bd returns non-zero, error is null and exitCode reflects bd's exit.
  error: string | null
}

function rejectResult(error: string): ConsoleRunResult {
  return { stdout: "", stderr: "", exitCode: 1, error }
}

export async function run(opts: ConsoleRunArgs): Promise<ConsoleRunResult> {
  const { args, db } = opts ?? { args: [], db: null }

  if (!Array.isArray(args) || args.length === 0) {
    return rejectResult("No command provided")
  }
  for (const arg of args) {
    if (typeof arg !== "string") {
      return rejectResult("Invalid argument type")
    }
    if (SHELL_META.test(arg)) {
      return rejectResult("Invalid argument: shell metacharacters rejected")
    }
    if (arg === "--db" || arg.startsWith("--db=")) {
      return rejectResult("Use 'db' parameter instead of --db flag")
    }
  }

  const command = args[0]
  if (!(ALLOWED_COMMANDS as readonly string[]).includes(command)) {
    return rejectResult(`Command '${command}' not allowed. Allowed: ${ALLOWED_COMMANDS.join(", ")}`)
  }

  // A bare command (no subcommand) just prints help — allowed.
  const allowedSubs = ALLOWED_SUBCOMMANDS[command]
  if (allowedSubs && args.length > 1 && !allowedSubs.includes(args[1])) {
    return rejectResult(
      `Subcommand '${command} ${args[1]}' not allowed. Allowed: ${allowedSubs
        .map((sub) => `${command} ${sub}`)
        .join(", ")}`,
    )
  }

  const bannedSubs = MUTATING_SUBCOMMAND_ANYWHERE[command]
  if (bannedSubs) {
    const banned = args.slice(1).find((arg) => bannedSubs.includes(arg))
    if (banned) {
      return rejectResult(`Subcommand '${command} ${banned}' not allowed (mutating)`)
    }
  }

  const bdArgs: string[] = []
  if (db) {
    if (typeof db !== "string" || !isValidDbPath(db)) {
      return rejectResult(
        `Invalid database path: ${db} (must be a .beads directory or a file inside one)`,
      )
    }
    bdArgs.push("--db", db)
  }
  bdArgs.push(...args)

  try {
    const { stdout, stderr } = await execFileAsync(resolveBdPath(), bdArgs, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: db ? buildEnv({ db }) : undefined,
    })
    return {
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
      error: null,
    }
  } catch (execError: unknown) {
    const err = execError as {
      stdout?: string
      stderr?: string
      message?: string
      code?: number
    }
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: typeof err.code === "number" ? err.code : 1,
      error: err.message ?? null,
    }
  }
}
