import { describe, expect, test } from "bun:test"
import { prefersDarkNow, resolveAppearance, subscribeSystemAppearance } from "../lib/appearance"

describe("resolveAppearance", () => {
  test("an explicit mode ignores the system preference", () => {
    expect(resolveAppearance("dark", false)).toBe("dark")
    expect(resolveAppearance("dark", true)).toBe("dark")
    expect(resolveAppearance("light", true)).toBe("light")
    expect(resolveAppearance("light", false)).toBe("light")
  })

  test("system mode follows the system preference", () => {
    expect(resolveAppearance("system", true)).toBe("dark")
    expect(resolveAppearance("system", false)).toBe("light")
  })
})

describe("system appearance listener", () => {
  test("prefersDarkNow reads the media query", () => {
    const original = window.matchMedia
    // @ts-expect-error test seam
    window.matchMedia = (q: string) => ({
      matches: q.includes("dark"),
      addEventListener() {},
      removeEventListener() {},
    })
    try {
      expect(prefersDarkNow()).toBe(true)
    } finally {
      window.matchMedia = original
    }
  })

  test("subscribe attaches a change listener and its unsubscribe detaches it", () => {
    const original = window.matchMedia
    let added = 0
    let removed = 0
    // @ts-expect-error test seam
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {
        added++
      },
      removeEventListener() {
        removed++
      },
    })
    try {
      const un = subscribeSystemAppearance(() => {})
      expect(added).toBe(1)
      un()
      expect(removed).toBe(1)
    } finally {
      window.matchMedia = original
    }
  })

  test("degrades to a no-op where matchMedia is unavailable", () => {
    const original = window.matchMedia
    // @ts-expect-error test seam
    window.matchMedia = undefined
    try {
      expect(prefersDarkNow()).toBe(false)
      expect(() => subscribeSystemAppearance(() => {})()).not.toThrow()
    } finally {
      window.matchMedia = original
    }
  })
})
