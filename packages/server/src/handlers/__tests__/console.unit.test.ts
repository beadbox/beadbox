// Dedicated security unit tests for handlers/console.ts (bb-zcv4).
//
// The console handler is the only kkrpc surface that accepts user-typed
// command arguments and invokes a child process. The allowlist + shell-
// metacharacter sanitizer + --db-flag rejection are the security boundary
// for that path. Coverage previously rode on the parity-runner fixtures
// (bb-vy13.7); these dedicated tests are the durable backstop so an
// accidental parity-runner refactor cannot silently drop the security
// surface.
//
// execFileAsync is mocked via mock.module so the tests don't depend on
// `bd` being installed and can directly assert the args the handler
// would have passed to the child process. Mock is hoisted before the
// handler import so the handler closes over the mocked function.
//
// Coverage matrix (matches the bead AC):
//   1. Allowlist accepts every command in ALLOWED_COMMANDS.
//   2. Allowlist rejects unknown commands.
//   3. Sanitizer rejects every documented shell metacharacter.
//   4. The child-process call uses execFile semantics (file + argv array,
//      not a single shell-joined command string), preserves the user's
//      command and args VERBATIM, and prepends --db only when a `db`
//      parameter is supplied.
// Plus the adjacent rejection paths the same security boundary owns:
//   - --db arg in user-supplied args (must use the `db` parameter).
//   - Invalid `db` parameter (must pass isValidDbPath).
//   - Empty / non-string args.

import { beforeAll, describe, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"

// Spy that captures every (file, args, options) tuple the handler tries
// to spawn during a test. Reset per-test inside describe blocks.
const execCalls: Array<{ file: string; args: string[]; options: unknown }> = []
const scopedIds: string[] = []

// Mock execFileAsync to return an empty success without ever spawning a
// child process. This makes "allowlist accepts" tests fast + hermetic
// regardless of whether bd is installed in the test environment.
mock.module("../../lib/exec", () => ({
  execFileAsync: async (file: string, args: string[], options: unknown) => {
    execCalls.push({ file, args, options })
    return { stdout: "", stderr: "" }
  },
  // Re-export anything else exec.ts exports so other consumers don't break
  // if they happen to import via this same module path during the test
  // run. exec.ts only exports execFileAsync + a re-export of existsSync.
  existsSync,
}))

// resolveBdPath is invoked by run() to build the argv. Mock it to a
// deterministic sentinel so tests can assert the file argument exactly.
mock.module("../../lib/bd-paths", () => ({
  resolveBdPath: () => "/fake/bin/bd",
  COMMON_BD_PATHS: [],
  __resetBdPathCache: () => {},
}))

mock.module("../../lib/workspace-resolver", () => ({
  resolveWorkspaceTarget: async () => ({ id: "console-test", cliDbPath: "/projects/foo/.beads" }),
}))
mock.module("../../lib/workspace-transition", () => ({
  workspaceTransition: {
    withOperation: async (id: string, run: () => Promise<unknown>) => {
      scopedIds.push(id)
      return run()
    },
  },
}))

// Import AFTER mocks are registered so the handler closes over the
// mocked references.
const { ALLOWED_COMMANDS, run: rawRun } = await import("../console")
const CONSOLE_DB = "/projects/foo/.beads"
const run = (opts: Parameters<typeof rawRun>[0]) => rawRun({ db: CONSOLE_DB, ...opts })

beforeAll(() => {
  execCalls.length = 0
})

describe("console.run — allowlist", () => {
  test("accepts every command in ALLOWED_COMMANDS", async () => {
    for (const cmd of ALLOWED_COMMANDS) {
      execCalls.length = 0
      const result = await run({ args: [cmd] })
      expect(result.error).toBeNull()
      expect(result.exitCode).toBe(0)
      expect(execCalls).toHaveLength(1)
      expect(execCalls[0]!.file).toBe("/fake/bin/bd")
      expect(execCalls[0]!.args).toEqual(cmd === "help" ? [cmd] : ["--db", CONSOLE_DB, cmd])
    }
  })

  test("rejects unknown commands without spawning a child process", async () => {
    const unknown = ["delete", "create", "update", "init", "doctor", "rm", "drop"]
    for (const cmd of unknown) {
      execCalls.length = 0
      const result = await run({ args: [cmd] })
      expect(result.error).toContain(`Command '${cmd}' not allowed`)
      expect(result.error).toContain("Allowed:")
      expect(result.exitCode).toBe(1)
      expect(execCalls).toHaveLength(0)
    }
  })

  test("rejects empty args array", async () => {
    execCalls.length = 0
    const result = await run({ args: [] })
    expect(result.error).toBe("No command provided")
    expect(execCalls).toHaveLength(0)
  })

  test("rejects non-string args", async () => {
    execCalls.length = 0
    // Cast through unknown to bypass the runtime type signature; the
    // handler's defensive check exists precisely because kkrpc data
    // arrives un-validated at the boundary.
    const result = await run({ args: [123 as unknown as string] })
    expect(result.error).toBe("Invalid argument type")
    expect(execCalls).toHaveLength(0)
  })
})

describe("console.run — shell metacharacter sanitizer", () => {
  // Every char in the SHELL_META regex must be rejected. Tests use a
  // safe leading command (any allowed cmd) so the only thing that can
  // reject is the metachar check.
  const META_CHARS = [";", "&", "|", "`", "$", "(", ")", "{", "}"]

  test.each(META_CHARS)("rejects shell metachar: %s", async (char) => {
    execCalls.length = 0
    const result = await run({ args: ["list", `id${char}name`] })
    expect(result.error).toBe("Invalid argument: shell metacharacters rejected")
    expect(result.exitCode).toBe(1)
    expect(execCalls).toHaveLength(0)
  })

  test("rejects metachar embedded mid-arg, not just leading position", async () => {
    execCalls.length = 0
    const result = await run({ args: ["search", "foo;rm -rf /"] })
    expect(result.error).toBe("Invalid argument: shell metacharacters rejected")
    expect(execCalls).toHaveLength(0)
  })

  test("rejects metachar in the COMMAND slot too — sanitizer runs before allowlist", async () => {
    execCalls.length = 0
    // `list;evil` is metachar-rejected before reaching the allowlist
    // (which would also reject it for being unknown). Either rejection
    // is acceptable; the test pins the metachar branch as primary so a
    // future allowlist refactor can't widen the surface by accident.
    const result = await run({ args: ["list;evil"] })
    expect(result.error).toBe("Invalid argument: shell metacharacters rejected")
    expect(execCalls).toHaveLength(0)
  })

  test("accepts hyphens, underscores, dots, slashes, and digits — these are NOT shell metas", async () => {
    execCalls.length = 0
    const result = await run({ args: ["list", "--limit", "10", "bd-abc.123"] })
    expect(result.error).toBeNull()
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]!.args).toEqual(["--db", CONSOLE_DB, "list", "--limit", "10", "bd-abc.123"])
  })
})

describe("console.run — --db flag rejection", () => {
  test("rejects --db as a standalone arg", async () => {
    execCalls.length = 0
    const result = await run({ args: ["list", "--db", "/some/path/.beads"] })
    expect(result.error).toBe("Use 'db' parameter instead of --db flag")
    expect(execCalls).toHaveLength(0)
  })

  test("rejects --db=value form", async () => {
    execCalls.length = 0
    const result = await run({ args: ["list", "--db=/some/path/.beads"] })
    expect(result.error).toBe("Use 'db' parameter instead of --db flag")
    expect(execCalls).toHaveLength(0)
  })
})

describe("console.run — db parameter validation", () => {
  test("rejects DB commands without a registered workspace", async () => {
    execCalls.length = 0
    const result = await rawRun({ args: ["list"] })
    expect(result.error).toBe("Select a registered workspace for this command")
    expect(execCalls).toHaveLength(0)
  })

  test("accepts a valid .beads directory path", async () => {
    execCalls.length = 0
    scopedIds.length = 0
    const result = await run({ args: ["list"], db: "/projects/foo/.beads" })
    expect(result.error).toBeNull()
    expect(scopedIds).toEqual(["console-test"])
    expect(execCalls).toHaveLength(1)
    // --db is prepended BEFORE the user's args, with the value the
    // caller supplied (after isValidDbPath approval).
    expect(execCalls[0]!.args[0]).toBe("--db")
    expect(execCalls[0]!.args[1]).toBe("/projects/foo/.beads")
    expect(execCalls[0]!.args.slice(2)).toEqual(["list"])
  })

  test("rejects a db path outside .beads structure", async () => {
    execCalls.length = 0
    const result = await run({ args: ["list"], db: "/etc/passwd" })
    expect(result.error).toContain("Invalid database path")
    expect(execCalls).toHaveLength(0)
  })

  test("rejects a db path containing a null byte", async () => {
    execCalls.length = 0
    const result = await run({ args: ["list"], db: "/projects/foo/.beads\0/etc" })
    expect(result.error).toContain("Invalid database path")
    expect(execCalls).toHaveLength(0)
  })

  test("rejects a non-string db parameter", async () => {
    execCalls.length = 0
    const result = await run({ args: ["list"], db: 123 as unknown as string })
    expect(result.error).toContain("Invalid database path")
    expect(execCalls).toHaveLength(0)
  })

  test("when db is null/undefined, no --db is prepended", async () => {
    execCalls.length = 0
    await run({ args: ["help"], db: null })
    expect(execCalls[0]!.args).toEqual(["help"])
    execCalls.length = 0
    await run({ args: ["help"] })
    expect(execCalls[0]!.args).toEqual(["help"])
  })
})

describe("console.run — child-process invocation contract", () => {
  test("uses execFile semantics: separate file + argv array, never a shell-joined string", async () => {
    execCalls.length = 0
    await run({ args: ["list"] })
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]!.file).toBe("/fake/bin/bd")
    // The mock signature is (file, args, options) — the execFile shape.
    // A handler refactor that switched to a single shell-joined string
    // would change the type at this boundary, so the assertions below
    // are a structural pin on the contract.
    expect(Array.isArray(execCalls[0]!.args)).toBe(true)
    expect(typeof execCalls[0]!.options).toBe("object")
  })

  test("preserves user args verbatim — no joining, no flag rewriting", async () => {
    execCalls.length = 0
    await run({ args: ["search", "needle in haystack"] })
    expect(execCalls[0]!.args).toEqual(["--db", CONSOLE_DB, "search", "needle in haystack"])
  })

  test("passes a 10s timeout + 10MB maxBuffer in options", async () => {
    execCalls.length = 0
    await run({ args: ["list"] })
    const opts = execCalls[0]!.options as { timeout?: number; maxBuffer?: number }
    expect(opts.timeout).toBe(10_000)
    expect(opts.maxBuffer).toBe(10 * 1024 * 1024)
  })

  test("surfaces child-process error fields without losing exitCode", async () => {
    // Re-mock for this single test to throw a child-process-style error.
    mock.module("../../lib/exec", () => ({
      execFileAsync: async () => {
        const err: { stdout: string; stderr: string; message: string; code: number } = {
          stdout: "partial",
          stderr: "boom",
          message: "Command failed: bd list",
          code: 7,
        }
        throw err
      },
      existsSync,
    }))

    // Re-import the handler so it picks up the new mock.
    const mod = await import("../console")
    const result = await mod.run({ args: ["list"], db: CONSOLE_DB })
    expect(result.exitCode).toBe(7)
    expect(result.stdout).toBe("partial")
    expect(result.stderr).toBe("boom")
    expect(result.error).toBe("Command failed: bd list")

    // Restore the success mock so subsequent describe blocks (if any)
    // see the original capturing behaviour.
    mock.module("../../lib/exec", () => ({
      execFileAsync: async (file: string, args: string[], options: unknown) => {
        execCalls.push({ file, args, options })
        return { stdout: "", stderr: "" }
      },
      existsSync,
    }))
  })
})
