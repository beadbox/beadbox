// Argv-construction guards for bd shell-outs (beadbox-l5i.3, item 3).
//
// Every bd invocation in this codebase already uses arg-array spawning
// (execFile / Bun.spawn, never shell:true), so classic shell-metacharacter
// injection is structurally impossible. The residual hazard is one level up:
// bd is a cobra/pflag CLI, and pflag lexes any argv token starting with "-"
// as a flag regardless of where the string came from. Verified against
// bd 1.0.5:
//
//   bd show --db=/tmp/evil     -> --db honoured; the command reads /tmp
//   bd show -- --db=/tmp/evil  -> treated as a positional bead ID
//
// A bead ID or title carrying "--db=..." therefore redirects the operation
// to another database. These helpers close that at the point user data
// enters argv.
//
// Why not just use the "--" terminator everywhere: buildArgs() appends
// "--json" AFTER the caller's args on every bdExec path, and "--" would
// swallow it, silently breaking JSON parsing. "--" is only safe on
// bdExecRaw paths where nothing follows the user data.

export class BdArgvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BdArgvError"
  }
}

// Bead IDs are machine-generated: a leading alphanumeric followed by
// alphanumerics, dot, dash or underscore ("bb-x0il", "beadbox-l5i.3").
// The leading-alphanumeric requirement is what makes flag injection
// impossible — no accepted ID can start with "-".
const BEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_BEAD_ID_LENGTH = 128

// Flag names are developer-supplied, never user data. Validating them
// catches typos at the seam (a mistyped "title" would otherwise become a
// positional argument and be silently interpreted as a bead ID).
const FLAG_NAME_PATTERN = /^--[a-z][a-z0-9-]*$/

/** Validate a bead ID destined for argv as a positional. Returns it unchanged. */
export function assertSafeBeadId(id: string): string {
  if (typeof id !== "string") {
    throw new BdArgvError(`Invalid bead ID: expected a string, got ${typeof id}`)
  }
  if (id.length === 0) {
    throw new BdArgvError("Invalid bead ID: empty")
  }
  if (id.length > MAX_BEAD_ID_LENGTH) {
    throw new BdArgvError(`Invalid bead ID: longer than ${MAX_BEAD_ID_LENGTH} characters`)
  }
  if (!BEAD_ID_PATTERN.test(id)) {
    throw new BdArgvError(
      `Invalid bead ID: ${id} (must start with a letter or digit and contain only letters, digits, '.', '-' and '_')`,
    )
  }
  return id
}

// Names that bd resolves itself (formula names, formula variable names). They
// are not machine-generated: users write formula names as filenames, and
// formulas also load from <repo>/.beads/formulas/, so a cloned repository
// chooses them (beadbox-c29). The guard is exactly as wide as the threat: bd
// is spawned with an argv array and no shell, so the only character that
// means anything is a LEADING '-', which pflag lexes as a flag. '_x', '.x',
// 'a+b', 'a@b', 'café' and 'sp ace' are plain data to bd and are accepted.
//
// Length bound: every name bd loads comes from a filename, and APFS / ext4 cap
// a filename at 255 bytes (242 once ".formula.toml" is removed). 4096 sits far
// above that and still bounds the argv we build.
const MAX_NAME_LENGTH = 4096

/** Validate a bd-resolved name destined for argv as a positional. Returns it unchanged. */
export function assertSafeName(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new BdArgvError(`Invalid ${label}: expected a string, got ${typeof value}`)
  }
  if (value.length === 0) {
    throw new BdArgvError(`Invalid ${label}: empty`)
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw new BdArgvError(`Invalid ${label}: longer than ${MAX_NAME_LENGTH} characters`)
  }
  if (value.includes("\0")) {
    throw new BdArgvError(`Invalid ${label}: contains a NUL byte`)
  }
  if (value.startsWith("-")) {
    throw new BdArgvError(`Invalid ${label}: ${value} (must not start with '-')`)
  }
  return value
}

/**
 * Validate a formula variable name for a --var=<name>=<value> token. Same as
 * assertSafeName, plus no '=': bd splits the token at the FIRST '=', so a name
 * containing one could never be set from the CLI and would silently assign a
 * different variable.
 */
export function assertSafeVarName(value: string): string {
  assertSafeName(value, "formula variable name")
  if (value.includes("=")) {
    throw new BdArgvError(`Invalid formula variable name: ${value} (must not contain '=')`)
  }
  return value
}

/** Validate a batch of bead IDs. Rejects the whole batch if any one is unsafe. */
export function assertSafeBeadIds(ids: string[]): string[] {
  for (const id of ids) assertSafeBeadId(id)
  return ids
}

/**
 * Build a single "--flag=value" argv token.
 *
 * Passing an option as one token instead of two is what makes the value
 * injection-proof: pflag splits on the FIRST "=", so everything after it is
 * the value even when the value itself looks like another flag.
 */
export function flagArg(flag: string, value: string): string {
  if (!FLAG_NAME_PATTERN.test(flag)) {
    throw new BdArgvError(`Invalid flag name: ${flag} (expected --lower-kebab-case)`)
  }
  if (typeof value !== "string") {
    throw new BdArgvError(`Invalid value for ${flag}: expected a string, got ${typeof value}`)
  }
  if (value.includes("\0")) {
    throw new BdArgvError(`Invalid value for ${flag}: contains a NUL byte`)
  }
  return `${flag}=${value}`
}

/**
 * Validate an identifier that is interpolated into SQL (comment row IDs).
 * Restricting to positive integers means no quoting question can arise.
 */
export function assertNumericId(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new BdArgvError(`Invalid ID: ${value} (must be a positive integer)`)
    }
    return String(value)
  }
  if (typeof value !== "string") {
    throw new BdArgvError(`Invalid ID: expected a string or number, got ${typeof value}`)
  }
  const trimmed = value.trim()
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new BdArgvError(`Invalid ID: ${value} (must be a positive integer)`)
  }
  return trimmed
}

/**
 * Build argv for `bd update <id> --<flag>=<value>`.
 *
 * The single call site for the whole update family (title, status, assignee,
 * priority, ...) so the ID guard and the =value form can't be forgotten on a
 * newly added field.
 */
export function buildUpdateArgs(id: string, flag: string, value: string): string[] {
  return ["update", assertSafeBeadId(id), flagArg(flag, value)]
}

/**
 * Build argv for `bd comment <id> -- <text>`.
 *
 * Comment text is a variadic positional (bd comment <id> [text...]), so it
 * can't use the --flag=value form; the "--" terminator is what stops a body
 * beginning with "-" from being lexed as a flag. Safe here specifically
 * because bdExecRaw appends nothing after the caller's args.
 */
export function buildCommentArgs(id: string, text: string): string[] {
  if (typeof text !== "string") {
    throw new BdArgvError(`Invalid comment text: expected a string, got ${typeof text}`)
  }
  if (text.includes("\0")) {
    throw new BdArgvError("Invalid comment text: contains a NUL byte")
  }
  return ["comment", assertSafeBeadId(id), "--", text]
}

/**
 * Guard a free-form value that must occupy a positional slot (e.g. the value
 * of `bd config set <key> <value>`), where neither the --flag=value form nor
 * a "--" terminator is available. Anything starting with "-" would be lexed
 * as a flag, so it is refused outright.
 */
export function assertNotFlagLike(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new BdArgvError(`Invalid ${label}: expected a string, got ${typeof value}`)
  }
  if (value.includes("\0")) {
    throw new BdArgvError(`Invalid ${label}: contains a NUL byte`)
  }
  if (value.startsWith("-")) {
    throw new BdArgvError(`Invalid ${label}: ${value} (must not start with '-')`)
  }
  return value
}
