// The server tests' default deadline comes from the preload, not bunfig
// (beadbox-mol-uua.1): bun 1.3.14 ignores bunfig's [test] timeout, so without
// _test-default-timeout.ts every file would run on bun's built-in 5 s.
import { expect, test } from "bun:test"

test("the test preload set the 30 s default deadline", () => {
  expect((globalThis as { __beadboxTestDefaultTimeoutMs?: number }).__beadboxTestDefaultTimeoutMs).toBe(30_000)
})
