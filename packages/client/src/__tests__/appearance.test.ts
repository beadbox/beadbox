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

  test("degrades to a no-op where matchMedia is unavailable, reading as dark", () => {
    const original = window.matchMedia
    // @ts-expect-error test seam
    window.matchMedia = undefined
    try {
      // REVERSED: this asserted false (light). With no OS signal the answer
      // has to be dark, because that is what is actually on screen —
      // index.html ships class="dark" and the :root palette is the dark one.
      // Reading "light" put `system` mode on a light theme over a dark paint.
      expect(prefersDarkNow()).toBe(true)
      expect(() => subscribeSystemAppearance(() => {})()).not.toThrow()
    } finally {
      window.matchMedia = original
    }
  })
})
