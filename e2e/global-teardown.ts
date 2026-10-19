// Global teardown for the headless harness (beadbox-r72.3).
//
// Every machine this runs on is shared: other agents' tests, hooks, sidecars
// and Dolt servers run as the same user. So nothing here kills by a generic
// pattern. Each worker already SIGKILLed the sidecar and Dolt pids it spawned
// (e2e/fixtures/harness.ts). What can remain are processes those pids left
// behind and that were reparented, such as bd's per-workspace proxy child.
// Every one of them carries this run's directory (a fresh mkdtemp) on its
// command line, and no other process can, so that path is what we match.
// Each pid killed is logged.

import { spawnSync } from "child_process"
import { rmSync } from "fs"
import { runDir } from "./fixtures/run-paths"

/** Live processes whose command line contains `needle`, excluding this one. */
export function processesUnder(needle: string): { pid: number; command: string }[] {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" })
  if (ps.status !== 0) throw new Error(`[e2e teardown] ps failed: ${ps.stderr}`)
  return ps.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), command: m[2] }))
    .filter((p) => p.command.includes(needle) && p.pid !== process.pid)
}

export default function globalTeardown() {
  const root = runDir()
  for (const { pid, command } of processesUnder(root)) {
    try {
      process.kill(pid, "SIGKILL")
      console.log(`[e2e teardown] killed leftover pid ${pid}: ${command.slice(0, 160)}`)
    } catch {
      // Exited between the listing and the kill.
    }
  }
  const left = processesUnder(root)
  console.log(`[e2e teardown] processes left under ${root}: ${left.length}`)
  if (process.env.E2E_KEEP_RUN_DIR !== "1") rmSync(root, { recursive: true, force: true })
}
