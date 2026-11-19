// beadbox-79a: the packaged smoke checks the views a release changes from
// inside the real WebView. It names them in a targets file and passes its path
// at launch as BEADBOX_SMOKE_VIEWS. Without that variable this namespace is
// inert: getTargets reports disabled and report writes nothing.
//
// No new IPC capability and no CSP change: the probe runs in the app's own
// client, reads targets over the existing sidecar channel, and reports one
// `[smoke-view] {...}` line to the sidecar log the smoke already reads.

import { readFileSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"

export interface SmokeAssertion {
  /** A CSS selector evaluated with querySelectorAll in the view. */
  selector: string
  /** At least this many elements must match. */
  minCount?: number
  /** The first match's computed value of this property must equal `equals`. */
  style?: { property: string; equals: string }
}

export interface SmokeTarget {
  id: string
  /** The client route to open, e.g. /all-projects. */
  route: string
  /** The view has rendered once this selector matches. */
  waitFor: string
  assertions: SmokeAssertion[]
}

export type SmokeTargets = { enabled: false } | { enabled: true; targets: SmokeTarget[] | null }

const MAX_FILE_BYTES = 64 * 1024
const MAX_TARGETS = 20
const MAX_ASSERTIONS = 20
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const ROUTE = /^\/[A-Za-z0-9/_-]{0,127}$/
const PROPERTY = /^[a-z][a-z-]{0,63}$/

function targetsPath(): string | null {
  const path = process.env.BEADBOX_SMOKE_VIEWS
  return path && isAbsolute(path) && !path.includes("\0") ? path : null
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

function parseAssertion(value: unknown): SmokeAssertion | null {
  if (!value || typeof value !== "object") return null
  const a = value as Record<string, unknown>
  if (!shortString(a.selector, 512)) return null
  const out: SmokeAssertion = { selector: a.selector }
  if (a.minCount !== undefined) {
    if (!Number.isInteger(a.minCount) || (a.minCount as number) < 0) return null
    out.minCount = a.minCount as number
  }
  if (a.style !== undefined) {
    const s = a.style as Record<string, unknown> | null
    if (!s || !shortString(s.property, 64) || !PROPERTY.test(s.property)) return null
    if (!shortString(s.equals, 128)) return null
    out.style = { property: s.property, equals: s.equals }
  }
  return out.minCount === undefined && out.style === undefined ? null : out
}

function parseTargets(text: string): SmokeTarget[] | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const list = (doc as { targets?: unknown } | null)?.targets
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TARGETS) return null
  const targets: SmokeTarget[] = []
  for (const value of list) {
    const t = value as Record<string, unknown> | null
    if (!t || !shortString(t.id, 64) || !ID.test(t.id)) return null
    if (!shortString(t.route, 128) || !ROUTE.test(t.route)) return null
    if (!shortString(t.waitFor, 512)) return null
    if (!Array.isArray(t.assertions) || t.assertions.length === 0) return null
    if (t.assertions.length > MAX_ASSERTIONS) return null
    const assertions = t.assertions.map(parseAssertion)
    if (assertions.some((a) => a === null)) return null
    targets.push({ id: t.id, route: t.route, waitFor: t.waitFor, assertions: assertions as SmokeAssertion[] })
  }
  return targets
}

function log(line: Record<string, unknown>): void {
  // console.error is mirrored to the sidecar log file (lib/log-file.ts).
  console.error(`[smoke-view] ${JSON.stringify(line)}`)
}

let reportedInvalid = false

/**
 * The smoke's targets, or disabled when the app was not launched by the smoke.
 * `targets` is null until the smoke publishes a valid file, so the client keeps
 * polling: the smoke writes it only after its live-update check.
 */
export function readSmokeTargets(): SmokeTargets {
  const path = targetsPath()
  if (!path) return { enabled: false }
  try {
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error("too large")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true, targets: null }
    if (!reportedInvalid) log({ target: "_targets", ok: false, detail: "targets file unreadable or too large" })
    reportedInvalid = true
    return { enabled: true, targets: null }
  }
  const targets = parseTargets(readFileSync(path, "utf8"))
  if (!targets && !reportedInvalid) {
    log({ target: "_targets", ok: false, detail: "targets file is not a valid smoke targets list" })
    reportedInvalid = true
  }
  return { enabled: true, targets }
}

/** Record one target's result in the sidecar log. Inert unless the smoke launched the app. */
export function reportSmokeView(result: { target: string; ok: boolean; detail: string }): boolean {
  if (!targetsPath()) return false
  const { target, ok, detail } = (result ?? {}) as Record<string, unknown>
  if (!shortString(target, 64) || !ID.test(target) || typeof ok !== "boolean") return false
  log({ target, ok, detail: typeof detail === "string" ? detail.slice(0, 500) : "" })
  return true
}

/** @internal tests only */
export function _resetSmokeForTests(): void {
  reportedInvalid = false
}
