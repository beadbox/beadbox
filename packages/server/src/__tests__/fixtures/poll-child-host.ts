// Host process for poll-child-lifetime.test.ts (beadbox-db6).
//
// Runs the REAL server-mode poll-child spawn (_startServerPollChild) the way
// the sidecar does, then ends itself the way the test asks — so the test can
// check what the poll child and its bd do when their parent goes away.
//
//   HOST_MODE=exit   process.exit(0) once the child is up (clean exit)
//   HOST_MODE=crash  an uncaught throw (crash)
//   HOST_MODE=hang   stay alive until the test signals us (SIGKILL / SIGTERM)

import { _startServerPollChild } from "../../lib/change-detector"
import { resetPathCaches } from "../../lib/bd-paths"

const dbPath = process.env.HOST_DB ?? ""
const id = process.env.HOST_ID ?? ""
const mode = process.env.HOST_MODE ?? "hang"
resetPathCaches()

const state = { dbPath, stopped: false, emit: () => {}, pollChild: null }
_startServerPollChild(state as unknown as Parameters<typeof _startServerPollChild>[0], id)
process.stdout.write(`READY ${process.pid}\n`)

if (mode === "exit") setTimeout(() => process.exit(0), 1500)
if (mode === "crash") {
  setTimeout(() => {
    throw new Error("db6 host: simulated crash")
  }, 1500)
}
// hang: the poll child's pipes keep this process alive until it is signalled.
setInterval(() => {}, 60_000)
