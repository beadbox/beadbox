// kkrpc handler mirror of actions/diagnostics.ts (P1.3 / bb-vy13.3).
//
// Parity contract: every export of actions/diagnostics.ts is mirrored here
// with identical signatures and return shapes. Body is structurally identical
// to the action; only "use server" and the @/lib import aliases are removed.
//
// The old action keeps running. P3 will switch call sites to this handler;
// P6 will delete the action.

import { dirname } from "node:path"
import { resolveBdPath } from "../lib/bd-paths"
import { execFileAsync } from "../lib/exec"
import { isValidDbPath } from "../lib/path-validation"
import { getActiveWorkspace } from "../lib/workspace-registry"
import { resolveWorkspaceTarget } from "../lib/workspace-resolver"
import { workspaceTransition } from "../lib/workspace-transition"

// bb-2a9b: bd doctor 1.0.x detects the workspace via process.cwd(), not the
// `--db` flag. The flag controls which database doctor QUERIES, but the
// embedded-vs-server detection branches on cwd having a `.beads/` subdir.
// Tauri's macOS GUI sidecar inherits cwd=/, so bd sees no .beads/ in cwd
// and emits a "not yet supported in embedded mode" note to stderr with
// EMPTY stdout AND exit code 0. The execFileAsync resolves successfully,
// JSON.parse("") throws, the outer catch gets a SyntaxError (no err.stdout/
// stderr), falls through every specific matcher, and returns the opaque
// catch-all. Fix: pass cwd = the project dir (parent of .beads/) so bd's
// cwd-detection latches onto the real workspace.
function projectDirFromDb(dbPath: string): string {
  if (dbPath.startsWith("server://")) return ""
  // Walk up: /Users/x/.beads → /Users/x  ;  /Users/x/.beads/beads.db → /Users/x
  let dir = dbPath
  while (dir && dir !== "/" && !dir.endsWith("/.beads")) dir = dirname(dir)
  if (dir.endsWith("/.beads")) dir = dirname(dir)
  return dir === "/" ? "" : dir
}

// ─── bd doctor diagnostics ─────────────────────────────────────────────────

export interface DiagnosticCheck {
  name: string
  status: "pass" | "warn" | "fail"
  explanation?: string
  commands?: string[]
}

export interface DiagnosticsResult {
  ok: boolean
  passed: number
  warnings: number
  errors: number
  checks: DiagnosticCheck[]
  error?: string
}

// Raw shape from bd doctor --agent --json
interface BdDoctorCheck {
  name: string
  status: "ok" | "warning" | "error"
  severity?: string
  category?: string
  explanation?: string
  observed?: string
  expected?: string
  commands?: string[]
  source_files?: string[]
}

interface BdDoctorOutput {
  overall_ok: boolean
  cli_version?: string
  summary?: string
  diagnostics: BdDoctorCheck[]
}

function mapCheckStatus(s: string): "pass" | "warn" | "fail" {
  switch (s) {
    case "ok":
      return "pass"
    case "warning":
      return "warn"
    case "error":
      return "fail"
    default:
      return "fail"
  }
}

function parseDoctorOutput(stdout: string): DiagnosticsResult {
  const raw: BdDoctorOutput = JSON.parse(stdout)
  // Filter out the "Installation" check: bd doctor checks process.cwd() for
  // .beads/ regardless of the --db flag. Since the Next.js server cwd is the
  // source directory (not the workspace project dir), this check always produces
  // a false positive. Workspace availability is validated separately by the
  // startup health check.
  const checks: DiagnosticCheck[] = raw.diagnostics
    .filter((d) => d.name !== "Installation")
    .map((d) => ({
      name: d.name,
      status: mapCheckStatus(d.status),
      explanation: d.explanation,
      commands: d.commands,
    }))

  const warnings = checks.filter((c) => c.status === "warn").length
  const errors = checks.filter((c) => c.status === "fail").length

  // bd doctor --agent --json only includes non-passing checks in the array.
  // Extract passed count from the summary string (e.g. "7 warning(s) found, 64 checks passed.")
  let passed = checks.filter((c) => c.status === "pass").length
  if (raw.summary) {
    const match = raw.summary.match(/(\d+)\s+checks?\s+passed/)
    if (match) passed = parseInt(match[1], 10)
  }

  return { ok: raw.overall_ok, passed, warnings, errors, checks }
}

export async function runDiagnostics(databasePath?: string): Promise<DiagnosticsResult> {
  // If no path provided, resolve from the workspace registry
  const resolvedPath = databasePath || (await getActiveWorkspace())
  if (!resolvedPath) {
    return {
      ok: false,
      passed: 0,
      warnings: 0,
      errors: 0,
      checks: [],
      error: "No active workspace. Select a workspace to run diagnostics.",
    }
  }
  if (resolvedPath.includes("/") && !isValidDbPath(resolvedPath)) {
    return {
      ok: false,
      passed: 0,
      warnings: 0,
      errors: 0,
      checks: [],
      error: `Invalid workspace path: ${resolvedPath} (must be a .beads directory or a file inside one)`,
    }
  }

  try {
    const target = await resolveWorkspaceTarget(resolvedPath)
    const { stdout, stderr } = await workspaceTransition.withOperation(target.id, async () => {
      const current = await resolveWorkspaceTarget(resolvedPath)
      if (current.id !== target.id) throw new Error("Workspace target changed")
      const cwd = projectDirFromDb(current.cliDbPath)
      return execFileAsync(
        resolveBdPath(),
        ["doctor", "--agent", "--json", "--db", current.cliDbPath],
        { cwd: cwd || undefined, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
      )
    })

    // Defensive: bd 1.0.x can exit 0 with EMPTY stdout when its cwd-based
    // workspace detection misfires (e.g. server-mode workspaces where
    // projectDirFromDb returned "", or any future edge bd surprises).
    // Don't pass empty stdout to JSON.parse — surface a clear error.
    if (!stdout.trim()) {
      return {
        ok: false,
        passed: 0,
        warnings: 0,
        errors: 0,
        checks: [],
        error: stderr.includes("embedded mode")
          ? "bd doctor doesn't support this workspace type yet (embedded mode). Run 'bd doctor' from a terminal in the workspace project directory."
          : `bd doctor returned no output. Stderr: ${stderr.slice(0, 200) || "(empty)"}`,
      }
    }

    if (stderr?.includes("unknown flag") || stderr?.includes("unknown command")) {
      return {
        ok: false,
        passed: 0,
        warnings: 0,
        errors: 0,
        checks: [],
        error:
          "Your version of beads does not support diagnostics. Update with: brew upgrade beads",
      }
    }

    return parseDoctorOutput(stdout)
  } catch (err: unknown) {
    const execErr = err as {
      killed?: boolean
      signal?: string
      stderr?: string
      stdout?: string
      message?: string
    }

    // bd doctor exits non-zero when warnings/errors are found, but stdout
    // still contains valid JSON. Parse it if available.
    if (execErr.stdout) {
      try {
        return parseDoctorOutput(execErr.stdout)
      } catch {
        // stdout wasn't valid JSON, fall through to error handling
      }
    }

    if (execErr.killed || execErr.signal === "SIGTERM") {
      return {
        ok: false,
        passed: 0,
        warnings: 0,
        errors: 0,
        checks: [],
        error: "Diagnostics timed out after 15 seconds.",
      }
    }

    const stderr = execErr.stderr || execErr.message || ""
    if (stderr.includes("unknown flag") || stderr.includes("unknown command")) {
      return {
        ok: false,
        passed: 0,
        warnings: 0,
        errors: 0,
        checks: [],
        error:
          "Your version of beads does not support diagnostics. Update with: brew upgrade beads",
      }
    }

    if (
      stderr.includes("no such file") ||
      stderr.includes("does not exist") ||
      stderr.includes("not a beads workspace")
    ) {
      return {
        ok: false,
        passed: 0,
        warnings: 0,
        errors: 0,
        checks: [],
        error: "Workspace not found. Select a valid workspace first.",
      }
    }

    return {
      ok: false,
      passed: 0,
      warnings: 0,
      errors: 0,
      checks: [],
      error: "Failed to run diagnostics. Try running bd doctor in your terminal.",
    }
  }
}
