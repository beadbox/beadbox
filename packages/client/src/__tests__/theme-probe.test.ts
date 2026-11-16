import { afterEach, describe, expect, test } from "bun:test"
import { __resetProbeCache, isThemingAvailable, probeTokenSupport } from "../lib/theme-engine"

afterEach(() => {
  document.documentElement.removeAttribute("style")
  document.querySelectorAll("[data-bb-probe]").forEach((n) => {
    n.remove()
  })
  __resetProbeCache()
})

describe("probeTokenSupport", () => {
  test("returns true when var() indirection resolves", () => {
    expect(probeTokenSupport()).toBe(true)
  })

  test("leaves no probe element behind", () => {
    probeTokenSupport()
    expect(document.querySelectorAll("[data-bb-probe]").length).toBe(0)
  })

  test("does not disturb existing tokens", () => {
    document.documentElement.style.setProperty("--bb-background", "#abcdef")
    probeTokenSupport()
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe("#abcdef")
  })
})

describe("isThemingAvailable", () => {
  test("returns false when probe throws (error safety)", () => {
    // Mock getComputedStyle to throw
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = () => {
      throw new Error("Simulated engine failure")
    }
    try {
      expect(isThemingAvailable()).toBe(false)
    } finally {
      window.getComputedStyle = originalGetComputedStyle
      __resetProbeCache()
    }
  })

  test("memoises the result (second call does not re-probe)", () => {
    const probe1 = isThemingAvailable()
    expect(probe1).toBe(true)

    // Second call should return cached result without re-probing
    const probe2 = isThemingAvailable()
    expect(probe2).toBe(probe1)
  })

  test("__resetProbeCache forces fresh probe on next call", () => {
    const firstCall = isThemingAvailable()
    expect(firstCall).toBe(true)

    // Reset the cache
    __resetProbeCache()

    // Next call should re-probe (but return same result in happy path)
    const secondCall = isThemingAvailable()
    expect(secondCall).toBe(true)
  })
})
