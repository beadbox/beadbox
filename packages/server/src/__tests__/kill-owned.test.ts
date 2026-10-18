// beadbox-622: serve-proxy-reap's afterEach SIGKILLed pids from a process-table
// snapshot and failed with ESRCH when one had already exited. killOwned treats
// ESRCH as "already gone" and keeps every other error fatal.

import { expect, mock, test } from "bun:test"
import { spawn } from "node:child_process"
import { killOwned } from "./fixtures/kill-owned"

const coded = (code: string) => Object.assign(new Error(`kill() failed: ${code}`), { code })

test("ESRCH (the pid already exited) is not an error: returns false", () => {
  const kill = mock(() => {
    throw coded("ESRCH")
  })
  expect(killOwned(4242, "SIGKILL", kill)).toBe(false)
  expect(kill).toHaveBeenCalledWith(4242, "SIGKILL")
})

test("any other error still throws (EPERM)", () => {
  const kill = mock(() => {
    throw coded("EPERM")
  })
  expect(() => killOwned(4242, "SIGKILL", kill)).toThrow("EPERM")
})

test("a delivered signal returns true", () => {
  const kill = mock(() => true as const)
  expect(killOwned(4242, "SIGKILL", kill)).toBe(true)
  expect(kill).toHaveBeenCalledWith(4242, "SIGKILL")
})

// The injected errors above must look like the real one. Signal 0 delivers
// nothing, so probing an exited pid this way can't touch a reused pid.
test("the real error for an exited pid carries code ESRCH", async () => {
  const child = spawn("true")
  await new Promise<void>((resolve) => child.on("exit", () => resolve()))
  await Bun.sleep(50)
  let code: unknown
  try {
    process.kill(child.pid as number, 0)
  } catch (err) {
    code = (err as { code?: unknown }).code
  }
  expect(code).toBe("ESRCH")
})
