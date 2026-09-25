// Wire contract for the dual-channel subscription transport.
//
// Background: tauri-plugin-js's createChannel does not proxy AsyncIterable
// methods (TB0.4 finding, commit 0af0aca). The validated alternative pairs
// imperative kkrpc methods (start/stop) with a structured event stream on
// stderr. tauri-plugin-js relays each stderr line as a Tauri event; the
// client filters by prefix.
//
// Channel: stderr. stdout is the kkrpc wire and a stray non-JSON byte
// corrupts the JSON-over-newline frame (see packages/server/src/index.ts).
// stderr already carries the boot diagnostic and uncaught-exception traces;
// SUBSCRIPTION lines coexist with those because the prefix is unambiguous.
//
// Format: one event per line, exactly:
//   [SUBSCRIPTION:<uuid>] <json>\n
// Lines that do not match the prefix are not subscription events.

export const SUBSCRIPTION_PREFIX = "[SUBSCRIPTION:"
export const SUBSCRIPTION_PREFIX_END = "] "

export type SubscriptionEvent =
  | {
      type: "change"
      timestamp: number
      trigger?: string
      prev?: string | null
      next?: string | null
    }
  | { type: "polling_error" }
  // bb-v340: emitted by change-detector on each retry past the initial
  // polling_error broadcast so the renderer can fire ws_reconnecting events
  // (matches v0.24.x WebSocket-era retry telemetry shape: attempt_number +
  // backoff_ms). See change-detector.ts:_handlePollError.
  | { type: "reconnecting"; attempt_number: number; backoff_ms: number }
  | { type: "recovered" }
  // beadbox-01f.2: the server-mode poll loop emits this after a successful
  // poll (first one, then at most every 10s). Its absence is how the client
  // tells "no changes" apart from "no detector".
  | { type: "heartbeat" }
  | { type: "bd_command"; [key: string]: unknown }

export function formatLine(id: string, payload: SubscriptionEvent): string {
  return `${SUBSCRIPTION_PREFIX}${id}${SUBSCRIPTION_PREFIX_END}${JSON.stringify(payload)}\n`
}

export interface ParsedLine {
  id: string
  payload: SubscriptionEvent
}

export function parseLine(line: string): ParsedLine | null {
  if (!line.startsWith(SUBSCRIPTION_PREFIX)) return null
  const endIdx = line.indexOf(SUBSCRIPTION_PREFIX_END, SUBSCRIPTION_PREFIX.length)
  if (endIdx === -1) return null
  const id = line.slice(SUBSCRIPTION_PREFIX.length, endIdx)
  const jsonStart = endIdx + SUBSCRIPTION_PREFIX_END.length
  const jsonStr = line.slice(jsonStart).replace(/\n$/, "")
  try {
    const payload = JSON.parse(jsonStr) as SubscriptionEvent
    return { id, payload }
  } catch {
    return null
  }
}
