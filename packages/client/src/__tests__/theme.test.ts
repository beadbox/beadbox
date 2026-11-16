// Rewritten for runtime themes. The previous version asserted gray-only
// rendering, which was the 0.25.2 limitation this feature removes.
import { afterEach, describe, expect, test } from "bun:test"
import {
  _resetThemePreferenceForTests,
  DEFAULT_THEME_ID,
  getThemePreference,
  resolveThemeId,
  setThemePreference,
  subscribeThemePreference,
} from "../lib/local-storage"
import { applyThemeClass } from "../lib/theme"

afterEach(() => {
  localStorage.clear()
  document.documentElement.className = ""
  _resetThemePreferenceForTests()
})

describe("theme preference", () => {
  test("defaults to the built-in dark theme", () => {
    expect(getThemePreference()).toBe(DEFAULT_THEME_ID)
  })

  test("round-trips an arbitrary custom theme id", () => {
    setThemePreference("nord")
    expect(getThemePreference()).toBe("nord")
  })

  test("a preference for a theme that is not installed is preserved, not rewritten", () => {
    setThemePreference("nord")
    expect(localStorage.getItem("beads-theme")).toBe("nord")
    expect(getThemePreference()).toBe("nord")
  })

  test("rejects a syntactically invalid id and falls back", () => {
    localStorage.setItem("beads-theme", "../../etc/passwd")
    expect(getThemePreference()).toBe(DEFAULT_THEME_ID)
  })

  test("a write survives in-memory for the session when the storage write throws", () => {
    const original = localStorage.setItem.bind(localStorage)
    localStorage.setItem = () => {
      throw new Error("Simulated quota/private-mode failure")
    }
    try {
      setThemePreference("nord")
      expect(getThemePreference()).toBe("nord")
    } finally {
      localStorage.setItem = original
    }
  })

  test("subscribers are still notified when the storage write throws", () => {
    const original = localStorage.setItem.bind(localStorage)
    localStorage.setItem = () => {
      throw new Error("Simulated quota/private-mode failure")
    }
    let calls = 0
    const unsubscribe = subscribeThemePreference(() => {
      calls++
    })
    try {
      setThemePreference("nord")
      expect(calls).toBe(1)
    } finally {
      unsubscribe()
      localStorage.setItem = original
    }
  })

  test("a normal write still persists and is readable after a fresh module/page load", () => {
    setThemePreference("nord")
    // Simulate a fresh module/page load: nothing held in memory, only
    // whatever got written to storage.
    _resetThemePreferenceForTests()
    expect(getThemePreference()).toBe("nord")
  })
})

describe("resolveThemeId", () => {
  test("a known id returns itself", () => {
    expect(resolveThemeId("beadbox-light", ["beadbox-dark", "beadbox-light"])).toBe("beadbox-light")
  })

  test("an unknown id returns the default", () => {
    expect(resolveThemeId("nord", ["beadbox-dark", "beadbox-light"])).toBe(DEFAULT_THEME_ID)
  })

  test("storage is untouched either way", () => {
    setThemePreference("nord")
    resolveThemeId("nord", ["beadbox-dark", "beadbox-light"])
    resolveThemeId("beadbox-dark", ["beadbox-dark", "beadbox-light"])
    expect(localStorage.getItem("beads-theme")).toBe("nord")
  })
})

describe("applyThemeClass", () => {
  test("dark appearance adds .dark", () => {
    applyThemeClass(document.documentElement, "dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  test("light appearance removes .dark", () => {
    document.documentElement.classList.add("dark")
    applyThemeClass(document.documentElement, "light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  test("no longer writes theme-* classes", () => {
    applyThemeClass(document.documentElement, "dark")
    expect(document.documentElement.className).toBe("dark")
  })
})
