import { describe, expect, test } from "bun:test"
import { describeExecFailure } from "../lib/bd"
import { stallMs } from "../lib/loop-stall"

// beadbox-0b6 AC9: the next failure must say what the last two could not.
describe("a failed bd call says how it failed", () => {
  test("killed by the exec timeout, with no stderr", () => {
    expect(describeExecFailure({ killed: true, signal: "SIGTERM", code: null, stderr: "" })).toBe(
      "killed=true signal=SIGTERM code=none stderr_bytes=0",
    )
  })

  test("failed on its own", () => {
    expect(describeExecFailure({ killed: false, signal: null, code: 1, stderr: "Error: no" })).toBe(
      "killed=false signal=none code=1 stderr_bytes=9",
    )
  })

  test("never carries stderr text or the command, which can hold credentials or paths", () => {
    const line = describeExecFailure({ code: 1, stderr: "password=hunter2" })
    expect(line).not.toContain("hunter2")
  })
})

describe("an event-loop stall is reported by its size", () => {
  test("a tick on time is not a stall", () => expect(stallMs(0, 5_000)).toBeNull())
  test("ordinary lateness is not a stall", () => expect(stallMs(0, 9_000)).toBeNull())
  test("a tick 15 s late is reported as 15 s", () => expect(stallMs(0, 20_000)).toBe(15_000))
})
