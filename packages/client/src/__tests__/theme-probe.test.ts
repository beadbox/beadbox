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

  describe("detects unresolvable var() across serialization forms", () => {
    test("returns false for spaced rgba(0, 0, 0, 0)", () => {
      const originalGetComputedStyle = window.getComputedStyle
      window.getComputedStyle = () =>
        ({
          backgroundColor: "rgba(0, 0, 0, 0)",
        }) as CSSStyleDeclaration
      try {
        expect(probeTokenSupport()).toBe(false)
      } finally {
        window.getComputedStyle = originalGetComputedStyle
      }
    })

    test("returns false for no-space rgba(0,0,0,0)", () => {
      const originalGetComputedStyle = window.getComputedStyle
      window.getComputedStyle = () =>
        ({
          backgroundColor: "rgba(0,0,0,0)",
        }) as CSSStyleDeclaration
      try {
        expect(probeTokenSupport()).toBe(false)
      } finally {
        window.getComputedStyle = originalGetComputedStyle
      }
    })

    test("returns false for mixed whitespace rgba(0,  0,\\t0, 0)", () => {
      const originalGetComputedStyle = window.getComputedStyle
      window.getComputedStyle = () =>
        ({
          backgroundColor: "rgba(0,  0,\t0, 0)",
        }) as CSSStyleDeclaration
      try {
        expect(probeTokenSupport()).toBe(false)
      } finally {
        window.getComputedStyle = originalGetComputedStyle
      }
    })

    test("returns false for transparent keyword", () => {
      const originalGetComputedStyle = window.getComputedStyle
      window.getComputedStyle = () =>
        ({
          backgroundColor: "transparent",
        }) as CSSStyleDeclaration
      try {
        expect(probeTokenSupport()).toBe(false)
      } finally {
        window.getComputedStyle = originalGetComputedStyle
      }
    })

    test("returns true for resolved value with alpha (rgba(1, 2, 3, 1))", () => {
      const originalGetComputedStyle = window.getComputedStyle
      window.getComputedStyle = () =>
        ({
          backgroundColor: "rgba(1, 2, 3, 1)",
        }) as CSSStyleDeclaration
      try {
        expect(probeTokenSupport()).toBe(true)
      } finally {
        window.getComputedStyle = originalGetComputedStyle
      }
    })

    test("returns true for modern space-separated syntax rgb(1 2 3)", () => {
      const originalGetComputedStyle = window.getComputedStyle
      window.getComputedStyle = () =>
        ({
          backgroundColor: "rgb(1 2 3)",
        }) as CSSStyleDeclaration
      try {
        expect(probeTokenSupport()).toBe(true)
      } finally {
        window.getComputedStyle = originalGetComputedStyle
      }
    })
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

  test("memoises result and __resetProbeCache forces fresh probe", () => {
    // Counts real probe invocations, so "memoised" is distinguishable from "re-probed"
    __resetProbeCache()
    let calls = 0
    const original = window.getComputedStyle
    window.getComputedStyle = ((el: Element) => {
      calls++
      return original(el)
    }) as typeof window.getComputedStyle
    try {
      expect(isThemingAvailable()).toBe(true)
      expect(calls).toBe(1) // first call probes
      expect(isThemingAvailable()).toBe(true)
      expect(calls).toBe(1) // second call is memoised — no new probe
      __resetProbeCache()
      expect(isThemingAvailable()).toBe(true)
      expect(calls).toBe(2) // reset forces a fresh probe
    } finally {
      window.getComputedStyle = original
    }
  })
})
