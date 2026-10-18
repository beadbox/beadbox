// Test cleanup: signal a pid this test owns, treating "already gone" as done.
// A process picked from a process-table snapshot can exit before the kill
// reaches it; that ESRCH is not a failure. Every other error (EPERM, a bad
// signal) still throws, so a real cleanup problem stays visible (beadbox-622).
// Callers choose WHICH pids to pass; this never widens the selection.

type Kill = (pid: number, signal?: NodeJS.Signals | number) => true

export function killOwned(pid: number, signal: NodeJS.Signals = "SIGKILL", kill: Kill = process.kill): boolean {
  try {
    kill(pid, signal)
    return true
  } catch (err) {
    if ((err as { code?: unknown }).code === "ESRCH") return false
    throw err
  }
}
