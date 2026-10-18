// The transport seam under bun test (beadbox-r72.2): the flag is off, so the
// page reaches the sidecar only through the Tauri shell, exactly as before.

import { afterEach, describe, expect, test } from "bun:test"
import { hasSidecarTransport } from "../lib/sidecar-transport"
import { isTauriRuntime } from "../lib/tauri-runtime"

type TauriWindow = { __TAURI_INTERNALS__?: unknown }

afterEach(() => {
  delete (window as unknown as TauriWindow).__TAURI_INTERNALS__
})

describe("hasSidecarTransport with the test transport compiled out", () => {
  test("the build-time flag is undefined under bun test", () => {
    expect(typeof __BEADBOX_TEST_TRANSPORT__).toBe("undefined")
  })

  test("no Tauri shell: no sidecar transport, and isTauriRuntime agrees", () => {
    expect(isTauriRuntime()).toBe(false)
    expect(hasSidecarTransport()).toBe(false)
  })

  test("in the Tauri shell: a sidecar transport, as before", () => {
    ;(window as unknown as TauriWindow).__TAURI_INTERNALS__ = {}
    expect(isTauriRuntime()).toBe(true)
    expect(hasSidecarTransport()).toBe(true)
  })
})
