// Beadbox sidecar handler registry.
//
// Each namespace is collected via `import * as <ns>` so kkrpc routes incoming
// calls by dotting into this object: `rpc.beads.updateBeadStatus(...)`,
// `rpc.epics.getEpics(...)`, etc. Type-only exports (interfaces, type
// aliases) are inert for kkrpc dispatch but useful for client-side type
// derivation.
//
// Phases:
//   P1.2 -> beads, epics
//   P1.3 -> workspaces, health, diagnostics
//   P1.4 -> activity, system, recovery
//   P1.5 -> formulas, molecules
//   P1.6 -> subscribe (dual-channel: kkrpc start/stop + stderr event stream)
//   P3.6 -> console (dev console + window.bd helper; allowlisted bd inspection)

import { wrapNamespace } from "../lib/handler-timeout"
import * as activity from "./activity"
import * as beads from "./beads"
import * as console from "./console"
import * as diagnostics from "./diagnostics"
import * as epics from "./epics"
import * as formulas from "./formulas"
import * as health from "./health"
import * as molecules from "./molecules"
import * as recovery from "./recovery"
import * as session from "./session"
import * as subscribe from "./subscribe"
import * as system from "./system"
import * as trains from "./trains"
import * as workspaces from "./workspaces"

// Per bb-3pqz, every kkrpc handler is wrapped in a 30s timeout race so a
// hung Dolt query (contention, zombie sidecar, mysql2 has no default per-
// query timeout) surfaces as HandlerTimeoutError to the client instead of
// hanging useState loading=true forever. subscribe is intentionally not
// wrapped: start/stop are short, but they govern a long-lived stderr
// SUBSCRIPTION: stream and we don't risk racing the dual-channel
// handshake. If a hang surfaces inside change-detector, that's a separate
// bead about the long-poll path, not the kkrpc method.
export const handlers = {
  activity: wrapNamespace(activity, "activity"),
  beads: wrapNamespace(beads, "beads"),
  console: wrapNamespace(console, "console"),
  diagnostics: wrapNamespace(diagnostics, "diagnostics"),
  epics: wrapNamespace(epics, "epics"),
  formulas: wrapNamespace(formulas, "formulas"),
  health: wrapNamespace(health, "health"),
  molecules: wrapNamespace(molecules, "molecules"),
  recovery: wrapNamespace(recovery, "recovery"),
  session: wrapNamespace(session, "session"),
  subscribe,
  system: wrapNamespace(system, "system"),
  trains: wrapNamespace(trains, "trains"),
  workspaces: wrapNamespace(workspaces, "workspaces"),
} as const

export type HandlerRegistry = typeof handlers
