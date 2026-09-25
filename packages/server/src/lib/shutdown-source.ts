// Who was around when the sidecar got SIGTERM (bb-0vlu), without anyone's
// command line (beadbox-9j1).
//
// The capture used to print `ps -O ... command` and `pgrep -l -f` output:
// the full argv of the sidecar, its parent and every process matching
// beadbox|tauri. It lands on stderr, which the sidecar mirrors into its
// persistent log (log-file.ts), and on a real machine it captured another
// program's API key. Now every process is reported as "pid ppid name" only:
// `ucomm` is the kernel's executable name (no path, no arguments) on macOS
// and on Linux (procps). pgrep may still MATCH on argv to find the
// processes, but nothing from argv is ever printed. No environment either.

// Bounds the stamp on a machine with many matching processes.
const MAX_PROCS = 64
const PROC_PATTERN = "[Bb]eadbox|tauri"

/** "pid ppid name" lines for the given pids; argv and env never appear. */
function psNames(pids: number[]): string {
  if (pids.length === 0) return ""
  try {
    const out = Bun.spawnSync(["ps", "-o", "pid=,ppid=,ucomm=", "-p", pids.join(",")])
    return (out.stdout?.toString() ?? "")
      .split("\n")
      .map((line) => line.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .join("\n")
  } catch {
    return "" // ps unavailable (e.g. Windows): non-fatal
  }
}

export function captureShutdownSource(): { parentChain: string; beadboxProcs: string } {
  const parentChain = psNames([process.pid, process.ppid])

  let pids: number[] = []
  try {
    // Without -l, pgrep prints pids only.
    const out = Bun.spawnSync(["pgrep", "-f", PROC_PATTERN])
    pids = (out.stdout?.toString() ?? "")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .slice(0, MAX_PROCS)
  } catch {
    /* pgrep unavailable: non-fatal */
  }
  return { parentChain, beadboxProcs: psNames(pids) }
}
