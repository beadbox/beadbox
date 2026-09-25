// Beadbox Bun sidecar entry point.
//
// Wires the empty handler registry to kkrpc-over-stdio. P1.[2-6] add real
// handler namespaces in ./handlers/index.ts; P4 wires this binary to the
// Tauri host via tauri-plugin-js; P5 compiles via `bun build --compile`.
//
// Channel discipline:
// - stdout is the kkrpc wire. No console.log on any path reachable from
//   handlers — a stray byte corrupts the JSON-over-newline frame and the
//   peer dies with a parse error.
// - stderr carries the boot diagnostic, uncaught exceptions, and (later in
//   P1.6) the structured TICK:/SUBSCRIPTION: event stream relayed through
//   tauri-plugin-js.
//
// This file is the sole entrypoint for `bun build --compile` (lands in P5).
// Keep it small.

// Channel-discipline enforcement MUST be the first import. lib/console-discipline
// rewires console.log/console.debug to stderr at module load time, before any
// other module body runs (notably lib/bd.ts which logs at top level during
// credential hydration). See that file for the rationale.
import "./lib/console-discipline"
import { BunIo, RPCChannel } from "kkrpc"
import { type HandlerRegistry, handlers } from "./handlers"
import { closeLogFile } from "./lib/log-file"
import { startParentDeathWatcherViaShell } from "./lib/parent-death-watcher"
import { serveManager } from "./lib/serve-manager"

// bb-x0il (replaces bb-6x9y's Worker-based variant): when the parent
// (Tauri host in production, bash/Claude Code wrapper in dev) dies
// without reaping us, the kernel reparents to PID 1 and we'd otherwise
// run forever at ~100% CPU. Shell-spawn watcher: a tiny /bin/sh child
// polls `kill -0 <parent>` and sends SIGKILL to us when the parent
// disappears. Survives `bun build --compile` because /bin/sh + kill are
// OS-provided (bb-6x9y's Worker variant relied on
// `new Worker(new URL("./...", import.meta.url))` which Bun's compile
// mode does NOT bundle, so the production sidecar silently no-op'd).
// No-op when started as a daemon (process.ppid === 1) or when Tauri
// reaps us cleanly via SIGTERM before the next 5s poll.
const stopWatcher = startParentDeathWatcherViaShell({ signal: "TERM" })

// Boot diagnostic on stderr — proves "did the binary even start?" when smoke
// tests fail. stdout is reserved for kkrpc frames, so this can't go there.
process.stderr.write(`[beadbox-sidecar] starting pid=${process.pid} bun=${Bun.version}\n`)

const io = new BunIo(Bun.stdin.stream())

// RPCChannel listens in the background. We hold a reference so GC doesn't
// reclaim it; Bun keeps the process alive until stdin closes.
const channel = new RPCChannel<HandlerRegistry, Record<string, never>, BunIo>(io, {
  expose: handlers,
})

// Graceful shutdown: parent (Tauri host) sends SIGTERM/SIGINT on quit. Tear
// down the channel cleanly and exit 0 so the parent doesn't see a non-zero
// status as a crash.
//
// bb-0vlu: rc.10 dogfood found a SIGTERM hitting the sidecar ~21s into boot
// (suspect: tauri-plugin-js handshake recovery) where shutdown() ran
// partially — wrote the "received" line, called closeLogFile(), but never
// reached process.exit(0). Result: live process with shuttingDown=true so
// future signals are ignored; only bb-x0il's shell watcher could reap it.
//
// Two additions versus the original handler:
//   1. SIGTERM source capture: synchronous `ps -O ppid,user,etime,command`
//      + `pgrep -l -f '[Bb]eadbox|tauri'` snapshot at signal receipt, before
//      any state mutation. Bun's signal handlers don't expose siginfo_t, so
//      out-of-band ps inspection is the only sender-identification we get.
//      Stamped as `[bb-0vlu] sigterm_received ...` — frontend's
//      sidecar-shutdown-stamp.ts parses this into window.__BEADBOX__.shutdown.
//   2. Watchdog escalation: if process.exit(0) doesn't actually kill us in
//      2s (Bun pending-work hang or downstream cleanup throw), SIGKILL self.
//      timer.unref() so it doesn't itself keep the event loop alive.
let shuttingDown = false
function captureShutdownSource(): { parentChain: string; beadboxProcs: string } {
  let parentChain = ""
  let beadboxProcs = ""
  try {
    // -O appends listed columns to the default output. -p limits to specific
    // PIDs. We list self + ppid; ppid's ppid is then walked by reading the
    // ppid field from the first ps row, but doing the walk in JS is fragile;
    // pgrep below catches the broader landscape (tauri-plugin-js helpers,
    // intermediate shells) which is the actually-useful signal.
    const psOut = Bun.spawnSync([
      "ps",
      "-O",
      "ppid,user,etime,command",
      "-p",
      `${process.pid},${process.ppid}`,
    ])
    parentChain = (psOut.stdout?.toString() ?? "").trim()
  } catch {
    /* ps unavailable — non-fatal */
  }
  try {
    const pgrepOut = Bun.spawnSync(["pgrep", "-l", "-f", "[Bb]eadbox|tauri"])
    beadboxProcs = (pgrepOut.stdout?.toString() ?? "").trim()
  } catch {
    /* pgrep unavailable — non-fatal */
  }
  return { parentChain, beadboxProcs }
}

async function shutdown(signal: NodeJS.Signals | "fatal", exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  // bb-0vlu: snapshot the process landscape BEFORE any state mutation so the
  // [bb-0vlu] line lands first in stderr / the WebView listener / the log
  // file (which we're about to close).
  const { parentChain, beadboxProcs } = captureShutdownSource()
  process.stderr.write(
    `[bb-0vlu] sigterm_received signal=${signal} pid=${process.pid} ppid=${process.ppid} parentChain=${JSON.stringify(parentChain)} beadboxProcs=${JSON.stringify(beadboxProcs)}\n`,
  )

  // bb-0vlu: shell-spawn watchdog. Bun's setTimeout is unreliable while
  // the main event loop is blocked (BunIo stdin reader, kkrpc message in
  // flight, or a hanging cleanup step below). Same problem bb-6x9y solved
  // for the parent-death watcher: spawn /bin/sh which has its own
  // independent scheduler. The shell child sleeps 30s then SIGKILLs us;
  // if process.exit(0) succeeds first, the kill -KILL on our (now-gone)
  // pid is a silent no-op. stderr inherits ours so the escalation line
  // lands in bb-pnk0's tee + tauri-plugin-js's onStderr relay.
  try {
    Bun.spawn(
      [
        "/bin/sh",
        "-c",
        `sleep 30; printf '[bb-0vlu] shutdown_watchdog_escalating signal=${signal} pid=${process.pid} reason=process_exit_hung\\n' >&2; kill -KILL ${process.pid} 2>/dev/null`,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    )
  } catch {
    /* spawn failed — non-fatal; we'll rely on process.exit below */
  }

  process.stderr.write(`[beadbox-sidecar] received ${signal}, shutting down\n`)
  try {
    stopWatcher()
  } catch {
    /* watcher already terminated */
  }
  try {
    channel.destroy()
  } catch (err) {
    process.stderr.write(`[beadbox-sidecar] channel.destroy() threw: ${String(err)}\n`)
  }
  try {
    await serveManager.stopAll()
  } catch (err) {
    process.stderr.write(`[beadbox-sidecar] bd serve shutdown failed: ${String(err)}\n`)
  }
  closeLogFile()
  process.exit(exitCode)
}
process.on("SIGTERM", () => { void shutdown("SIGTERM") })
process.on("SIGINT", () => { void shutdown("SIGINT") })

// Uncaught failures must never silently kill the sidecar without leaving a
// trace. Write to stderr (Tauri host relays it as a `js-process-stderr`
// event) and exit non-zero so the parent treats it as a crash.
process.on("uncaughtException", (err) => {
  process.stderr.write(`[beadbox-sidecar] uncaughtException: ${err.stack ?? String(err)}\n`)
  void shutdown("fatal", 1)
})
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[beadbox-sidecar] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? String(reason)) : String(reason)}\n`,
  )
  void shutdown("fatal", 1)
})
