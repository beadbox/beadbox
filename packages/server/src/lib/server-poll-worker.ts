// Keep pool diagnostics off kkrpc stdout in this separate JS realm.
import "./console-discipline"

// A separate Bun event loop keeps SQL subscriptions live while the sidecar's
// kkrpc stdin reader is idle. This worker never runs bd or uses the CLI path.
import { formatLine, type SubscriptionEvent } from "../subscribe-protocol"
import { drainPool, getPool } from "./dolt-pool"
import { createPollEvents } from "./server-poll-events"
import { SERVER_POLL_SQL } from "./server-poll-sql"

type StartMessage = {
  type: "start"
  id: string
  dbPath: string
  workspaceId?: string
  intervalMs: number
  retryMs: number
}

let stopped = false
let timer: ReturnType<typeof setTimeout> | undefined

async function run({ id, dbPath, workspaceId, intervalMs, retryMs }: StartMessage): Promise<void> {
  const events = createPollEvents()

  const emit = (event: SubscriptionEvent): void => {
    if (!stopped) process.stderr.write(formatLine(id, event))
  }

  const poll = async (): Promise<void> => {
    if (stopped) return
    let delay = intervalMs
    try {
      const pool = await getPool(dbPath, workspaceId)
      const [rows] = await pool.query(SERVER_POLL_SQL)
      if (stopped) return
      const result = JSON.stringify(rows)
      for (const event of events.success(result)) emit(event)
    } catch (err) {
      if (stopped) return
      delay = retryMs
      for (const event of events.failure(retryMs)) emit(event)
      const message = err instanceof Error ? err.message : String(err)
      console.debug(`[change-detector] SQL poll error for ${dbPath}: ${message}`)
      await drainPool(dbPath, workspaceId).catch(() => {})
    } finally {
      if (!stopped) timer = setTimeout(poll, delay)
    }
  }

  // The first query establishes a baseline; a synthetic initial event is
  // emitted by the parent before this poll starts.
  await poll()
}

self.onmessage = (event: MessageEvent<StartMessage | { type: "stop" }>) => {
  if (event.data.type === "stop") {
    stopped = true
    if (timer) clearTimeout(timer)
    return
  }
  void run(event.data)
}
