// Host process for serve-lifetime.test.ts (beadbox-6x2 L2). Starts a REAL
// serve child through ServeManager the way the sidecar will, reports it, then
// ends itself the way the test asks, so the test can check what the child
// and its token do when their parent goes away.
//
//   HOST_MODE=exit   process.exit(0) once the child is up
//   HOST_MODE=crash  an uncaught throw
//   HOST_MODE=hang   stay alive until the test signals us (SIGKILL)

import { ServeManager } from "../../lib/serve-manager"

const mode = process.env.HOST_MODE ?? "hang"
const manager = new ServeManager({ bdPath: () => process.env.HOST_BD ?? "", tokenRoot: process.env.HOST_TOKEN_ROOT })
const handle = await manager.get({ key: "ws", workspaceDir: process.env.HOST_WS ?? "", env: {} })
const [tokenDir] = [...manager.liveTokenDirs()]
process.stdout.write(`READY ${JSON.stringify({ wrapperPid: handle.pid, url: handle.url, tokenDir })}\n`)

if (mode === "exit") setTimeout(() => process.exit(0), 300)
if (mode === "crash") {
  setTimeout(() => {
    throw new Error("serve host: simulated crash")
  }, 300)
}
setInterval(() => {}, 60_000)
