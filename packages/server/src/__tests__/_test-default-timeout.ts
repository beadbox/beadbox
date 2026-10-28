// Preloaded before every server test file (bunfig.toml). Sets the per-test
// default deadline that bunfig's `[test] timeout = 30000` was meant to set:
// bun 1.3.14 does not apply that key, so every file without its own
// setDefaultTimeout ran on bun's built-in 5 s, and on a loaded Mac tests that
// wait for real processes ran past it and failed pushes (beadbox-mol-uua.1).
// A file's own setDefaultTimeout still overrides this one.
import { setDefaultTimeout } from "bun:test"

export const TEST_DEFAULT_TIMEOUT_MS = 30_000

setDefaultTimeout(TEST_DEFAULT_TIMEOUT_MS)
// For test-default-timeout.test.ts, which asserts this preload ran.
;(globalThis as { __beadboxTestDefaultTimeoutMs?: number }).__beadboxTestDefaultTimeoutMs = TEST_DEFAULT_TIMEOUT_MS
