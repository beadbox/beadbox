// Condition-polling helper for tests that wait on an async side effect
// (fs-watcher debounce, stderr write, callback firing) instead of sleeping a
// fixed duration. A fixed sleep races the real timing: short enough to be
// fast when idle, it is still a guess, and guesses fail under load — the
// full server suite runs ~1089 tests with heavy parallel subprocess and
// filesystem work, which can push fs-event delivery plus a debounce past a
// "generous-looking" fixed wait (task 13 addendum).
//
// waitFor polls instead: it returns almost immediately when the system is
// idle, and simply waits longer under load, up to timeoutMs. Use it only for
// asserting something DID happen — you cannot poll for an absence, so a
// bounded sleep followed by an absence assertion is still the right shape
// for "nothing happened" tests.
export interface WaitForOptions {
  /** What is being waited for, surfaced in the timeout error so a genuine regression stays legible. */
  description: string
  timeoutMs?: number
  intervalMs?: number
}

export async function waitFor(predicate: () => boolean, options: WaitForOptions): Promise<void> {
  const { description, timeoutMs = 5000, intervalMs = 25 } = options
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  if (predicate()) return
  throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for: ${description}`)
}
