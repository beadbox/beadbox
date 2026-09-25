// bd error classification + recovery primitive routing.
//
// Architectural principle (qa1 observation, bb-s1nu 2026-04-25):
// **JSONL is the source of truth; Dolt is the runtime.** Several distinct
// error categories surface as different bd failures but converge to the same
// recovery action: rebuild Dolt from the JSONL backup via `bd init --from-jsonl`.
// Today this includes `out-of-sync` (Dolt drifted from JSONL via branch switch
// or external mutation) and `database-not-found` (Dolt data dir missing on a
// branch where JSONL exists). Both route through the same fixCommand below.
//
// Future categories that boil down to "Dolt state diverged from git" should
// reuse the same recovery primitive — name a new BdErrorCategory, classify
// the bd failure, set fixCommand to `bd init --from-jsonl`. Don't invent a
// parallel recovery path; the JSONL convergence is the contract that lets
// the recovery UI stay simple (one fix screen, multiple triggers).
//
// ────────────────────────────────────────────────────────────────────────
//
// Extract a human-readable message from bd's error output.
// bd may emit errors as pretty-printed JSON: { "error": "..." }
// This function extracts the .error field if present, falling back
// to the original text. Handles optional non-JSON prefix lines
// (e.g., "warning: ..." before the JSON block).
import { bdUpgradeHint } from "./version-requirements"

export function extractBdMessage(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed

  // Find where a JSON object starts in the text
  const jsonStart = trimmed.indexOf("{")
  if (jsonStart === -1) return trimmed

  // Extract from the opening brace to the end
  const jsonCandidate = trimmed.slice(jsonStart)
  try {
    const parsed = JSON.parse(jsonCandidate)
    if (parsed && typeof parsed.error === "string") {
      // Preserve any non-JSON prefix (e.g., "warning: ...")
      const prefix = trimmed.slice(0, jsonStart).trim()
      const errorMsg = parsed.error.trim()
      return prefix ? `${prefix}\n${errorMsg}` : errorMsg
    }
  } catch {
    // Not valid JSON; return original text
  }
  return trimmed
}

export type BdErrorCategory =
  | "access-denied"
  | "flock-contention"
  | "out-of-sync"
  | "database-not-found"
  | "permission-denied"
  | "schema-migration-needed"
  | "schema-missing"
  | "server-unreachable"
  | "timeout"
  | "unexpected-output"
  | "output-too-large"
  | "unknown"

export type BdErrorSeverity = "fatal" | "recoverable" | "transient"

export class BdError extends Error {
  category: BdErrorCategory
  severity: BdErrorSeverity
  stderr: string | null
  exitCode: number | null
  fixCommand: string | null
  fixDescription: string | null

  constructor(
    message: string,
    opts: {
      category: BdErrorCategory
      severity: BdErrorSeverity
      stderr?: string | null
      exitCode?: number | null
      fixCommand?: string | null
      fixDescription?: string | null
      cause?: unknown
    },
  ) {
    super(message, { cause: opts.cause })
    this.name = "BdError"
    this.category = opts.category
    this.severity = opts.severity
    this.stderr = opts.stderr ?? null
    this.exitCode = opts.exitCode ?? null
    this.fixCommand = opts.fixCommand ?? null
    this.fixDescription = opts.fixDescription ?? null
  }
}

// execFile rejects with this code when a child writes more stdout than the
// call's maxBuffer (beadbox-uk2). Retrying returns the same output, so the
// error is fatal, and the message names the limit that was hit.
export const MAXBUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"

export function outputTooLargeError(limitBytes: number, cause: unknown): BdError {
  const mib = Math.round(limitBytes / (1024 * 1024))
  return new BdError(
    `bd returned more output than Beadbox will read (${mib} MiB limit). This workspace is too large to load in one call.`,
    { category: "output-too-large", severity: "fatal", cause },
  )
}

// Serializable error shape for client consumption (cannot send class instances
// across the server action boundary).
export interface BdLoadError {
  category: BdErrorCategory
  severity: BdErrorSeverity
  message: string
  stderr: string | null
  fixCommand: string | null
  fixDescription: string | null
}

// Pattern table: ordered from most specific to most general.
// First match wins. Checks stderr first, then error.message.
interface ErrorPattern {
  test: (text: string) => boolean
  category: BdErrorCategory
  severity: BdErrorSeverity
  fixCommand: string | null
  fixDescription: string | null
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    // Fallback for exec paths that bypass handleBdError, where the limit is
    // not known; handleBdError names it (outputTooLargeError).
    test: (t) => /maxBuffer length exceeded/i.test(t),
    category: "output-too-large",
    severity: "fatal",
    fixCommand: null,
    fixDescription: null,
  },
  {
    // bd 1.0+ embedded mode uses flock for concurrency control
    test: (t) => /another process holds the exclusive lock/i.test(t) || /flock.*locked/i.test(t),
    category: "flock-contention",
    severity: "transient",
    fixCommand: null,
    fixDescription: "Another bd process is writing. Retry automatically.",
  },
  {
    // bd outputs: "database out of sync: issues.jsonl is newer than last import ..."
    test: (t) => /database\b.*\bout of sync/i.test(t),
    category: "out-of-sync",
    severity: "fatal",
    fixCommand: "bd init --from-jsonl",
    fixDescription: "Re-sync workspace from JSONL backup",
  },
  {
    // bd outputs: 'database "beads" not found on Dolt server at 127.0.0.1:3307'
    // The db name between "database" and "not found" breaks literal includes().
    //
    // bb-s1nu: bd's own error message lists "Switched git branches (the Dolt
    // database is runtime state, not in git)" as the first cause. Restarting
    // the Dolt server doesn't help — the server IS running, the database name
    // is just missing from its data dir. The right recovery is reconstructing
    // from issues.jsonl (which IS tracked in git, so it carries the right
    // state for the new branch). Same fix the out-of-sync pattern above uses;
    // both conditions converge on "JSONL is source of truth, Dolt is runtime".
    test: (t) => /database\b.*\bnot found/i.test(t),
    category: "database-not-found",
    severity: "fatal",
    fixCommand: "bd init --from-jsonl",
    fixDescription:
      "Likely after a git branch switch — Dolt runtime data is not tracked in git but issues.jsonl is. Re-import from JSONL backup to reconstruct the database.",
  },
  {
    // MySQL 1045 (28000): Access denied for user 'root'@'127.0.0.1' (using password: YES)
    // Must come before server-unreachable and generic permission-denied patterns,
    // which would match "access denied" text but classify it incorrectly.
    test: (t) => /access denied|error 1045|\(28000\)/i.test(t),
    category: "access-denied",
    severity: "recoverable",
    fixCommand: null,
    fixDescription: "Server requires authentication. Re-enter credentials.",
  },
  {
    // bd wraps ECONNREFUSED into "Dolt server unreachable at HOST:PORT" when
    // auto-start fails. The raw "connection refused" text may be absent when
    // the auto-start failure reason replaces it (e.g. lock file errors,
    // permission denied on lock file). Must come before permission-denied
    // because the auto-start failure reason can contain "permission denied"
    // as a secondary detail, but the primary error is server-unreachable.
    test: (t) => /server unreachable/i.test(t),
    category: "server-unreachable",
    severity: "recoverable",
    fixCommand: "bd dolt start",
    fixDescription: "Start the Dolt server",
  },
  {
    test: (t) => t.includes("EACCES") || /permission denied/i.test(t),
    category: "permission-denied",
    severity: "recoverable",
    fixCommand: null,
    fixDescription: "Check file permissions on workspace directory",
  },
  {
    // bd/Dolt outputs: 'column "started_at" could not be found in any table in scope'
    // when the workspace was created before a schema migration added the column.
    // Must come before schema-missing (which matches "table not found") because
    // the two can co-occur and schema-migration-needed has a different remediation
    // (run `bd migrate`, not `bd init`). bd 1.0.1+ ships columns that older
    // workspaces lack until `bd migrate` runs.
    test: (t) => /column\s+\\?["`']?\w+\\?["`']?\s+could not be found/i.test(t),
    category: "schema-migration-needed",
    severity: "recoverable",
    fixCommand: "bd migrate",
    fixDescription: "Apply pending schema migrations to this workspace",
  },
  {
    // bd/Dolt outputs: 'Error 1146 (HY000): table not found: issues'
    // Also matches: "Table 'beads.issues' doesn't exist"
    test: (t) => /table\b.*\bnot found/i.test(t) || /table\b.*\bdoesn'?t exist/i.test(t),
    category: "schema-missing",
    severity: "fatal",
    fixCommand: "bd init",
    fixDescription: "Initialize beads schema in this database",
  },
  {
    // bd outputs: "dolt circuit breaker is open: server appears down, failing fast (cooldown 30s)"
    test: (t) => /circuit breaker/i.test(t),
    category: "server-unreachable",
    severity: "recoverable",
    fixCommand: "bd dolt start",
    fixDescription: "Restart the Dolt server",
  },
  {
    // Node emits ECONNREFUSED; Go/Dolt uses "connection refused"
    test: (t) => /ECONNREFUSED|connection refused/i.test(t),
    category: "server-unreachable",
    severity: "recoverable",
    fixCommand: "bd dolt start",
    fixDescription: "Start the Dolt server",
  },
  {
    test: (t) => /ETIMEDOUT|timeout/i.test(t),
    category: "timeout",
    severity: "transient",
    fixCommand: null,
    fixDescription: null,
  },
  {
    // bd returned human-readable output instead of JSON despite --json flag.
    // Happens when bd version doesn't support --json for the subcommand,
    // or bd ignores --json in edge cases. The raw V8 SyntaxError message
    // ("Unexpected token X, ... is not valid JSON") must not leak to the UI.
    test: (t) => /is not valid JSON/i.test(t) || /unexpected output format/i.test(t),
    category: "unexpected-output",
    severity: "recoverable",
    ...bdUpgradeHint(process.platform),
  },
]

// Convert any error to a serializable BdLoadError on the server side,
// where instanceof BdError is reliable. Use this instead of throwing
// across the server action boundary.
export function toBdLoadError(error: unknown): BdLoadError {
  if (error instanceof BdError) {
    return {
      category: error.category,
      severity: error.severity,
      message: error.message,
      stderr: error.stderr,
      fixCommand: error.fixCommand,
      fixDescription: error.fixDescription,
    }
  }

  // For plain errors, run the pattern table to classify
  const e = error as { stderr?: string; message?: string }
  const stderr = e.stderr ?? ""
  const message = e.message ?? String(error)
  const searchText = `${stderr} ${message}`
  const humanMessage = extractBdMessage(stderr) || message

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(searchText)) {
      return {
        category: pattern.category,
        severity: pattern.severity,
        message: humanMessage,
        stderr: stderr || null,
        fixCommand: pattern.fixCommand,
        fixDescription: pattern.fixDescription,
      }
    }
  }

  return {
    category: "unknown",
    severity: "transient",
    message: humanMessage || "Unknown bd error",
    stderr: stderr || null,
    fixCommand: null,
    fixDescription: null,
  }
}

// Classify a raw error (from Node's execFile or similar) into a structured
// BdError. Always throws; never returns normally.
export function classifyBdError(error: unknown): never {
  const e = error as { stderr?: string; message?: string; code?: string | number }
  const stderr = e.stderr ?? ""
  const message = e.message ?? ""
  const searchText = `${stderr} ${message}`

  // Extract exit code from the raw error when available
  const exitCode = typeof e.code === "number" ? e.code : null

  const humanMessage = extractBdMessage(stderr) || message

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(searchText)) {
      throw new BdError(humanMessage, {
        category: pattern.category,
        severity: pattern.severity,
        stderr: stderr || null,
        exitCode,
        fixCommand: pattern.fixCommand,
        fixDescription: pattern.fixDescription,
        cause: error,
      })
    }
  }

  // No pattern matched: unknown/transient fallback
  throw new BdError(humanMessage || "Unknown bd error", {
    category: "unknown",
    severity: "transient",
    stderr: stderr || null,
    exitCode,
    fixCommand: null,
    fixDescription: null,
    cause: error,
  })
}
