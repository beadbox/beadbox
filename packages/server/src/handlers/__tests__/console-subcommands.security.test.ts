// Console handler subcommand allowlist (beadbox-l5i.3, item 2).
//
// handlers/console.ts documents itself as read-only: "only the read-only
// inspection commands listed in ALLOWED_COMMANDS may be invoked ... mutation
// paths flow through the typed rpc.{beads,epics,...} handlers with their own
// validation."
//
// That was not true. The allowlist only ever checked args[0], and three of the
// seven allowed commands have MUTATING subcommands (verified against bd 1.0.5):
//
//   bd dep add|remove|relate|unrelate      -> edits the dependency graph
//   bd config set|set-many|unset|apply     -> rewrites workspace config
//   bd comments add                        -> writes a comment
//
// So `rpc.console.run({ args: ["dep", "remove", ...] })` was a full mutation
// through the handler the checklist calls "the single most exploitable
// endpoint class in the app". These tests pin the subcommand-level gate.

import { beforeAll, describe, expect, mock, test } from "bun:test"

const execCalls: Array<{ file: string; args: string[] }> = []

mock.module("../../lib/exec", () => ({
  execFileAsync: async (file: string, args: string[]) => {
    execCalls.push({ file, args })
    return { stdout: "", stderr: "" }
  },
}))
mock.module("../../lib/bd-paths", () => ({
  resolveBdPath: () => "/fake/bin/bd",
  COMMON_BD_PATHS: [],
  resetPathCaches: () => {},
  __resetBdPathCache: () => {},
}))

mock.module("../../lib/workspace-resolver", () => ({
  resolveWorkspaceTarget: async () => ({ id: "console-test", cliDbPath: "/projects/foo/.beads" }),
}))
mock.module("../../lib/workspace-transition", () => ({
  workspaceTransition: { withOperation: async (_id: string, run: () => Promise<unknown>) => run() },
}))

const { run: rawRun } = await import("../console")
const run = (opts: Parameters<typeof rawRun>[0]) => rawRun({ db: "/projects/foo/.beads", ...opts })

beforeAll(() => {
  execCalls.length = 0
})

const MUTATING: Array<[string, string[]]> = [
  ["dep add", ["dep", "add", "bb-1", "bb-2"]],
  ["dep remove", ["dep", "remove", "bb-1", "bb-2"]],
  ["dep relate", ["dep", "relate", "bb-1", "bb-2"]],
  ["dep unrelate", ["dep", "unrelate", "bb-1", "bb-2"]],
  ["config set", ["config", "set", "status.custom", "pwned"]],
  ["config set-many", ["config", "set-many", "a=b"]],
  ["config unset", ["config", "unset", "status.custom"]],
  ["config apply", ["config", "apply"]],
  ["comments add", ["comments", "bb-1", "add", "text"]],
  ["comments add (subcommand first)", ["comments", "add", "bb-1", "text"]],
]

describe("console.run rejects mutating subcommands", () => {
  for (const [name, args] of MUTATING) {
    test(`rejects ${name} without spawning bd`, async () => {
      execCalls.length = 0
      const result = await run({ args })
      expect(result.exitCode).toBe(1)
      expect(result.error).toBeTruthy()
      expect(execCalls).toHaveLength(0)
    })
  }
})

const READ_ONLY: Array<[string, string[]]> = [
  ["dep list", ["dep", "list", "bb-1"]],
  ["dep tree", ["dep", "tree", "bb-1"]],
  ["dep cycles", ["dep", "cycles"]],
  ["config get", ["config", "get", "status.custom"]],
  ["config list", ["config", "list"]],
  ["config show", ["config", "show"]],
  ["bare dep (prints help)", ["dep"]],
  ["bare config (prints help)", ["config"]],
  ["comments by id", ["comments", "bb-1"]],
  ["show", ["show", "bb-1"]],
  ["list", ["list"]],
  ["search", ["search", "widget"]],
]

describe("console.run still permits read-only inspection", () => {
  for (const [name, args] of READ_ONLY) {
    test(`permits ${name}`, async () => {
      execCalls.length = 0
      const result = await run({ args })
      expect(result.error).toBeNull()
      expect(execCalls).toHaveLength(1)
    })
  }
})
