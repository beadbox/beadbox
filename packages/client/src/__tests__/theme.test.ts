// Rewritten for runtime themes. The previous version asserted gray-only
// rendering, which was the 0.25.2 limitation this feature removes.
import { afterEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_THEME_ID,
  getThemePreference,
  resolveThemeId,
  setThemePreference,
} from "../lib/local-storage"
import { applyThemeClass } from "../lib/theme"

afterEach(() => {
  localStorage.clear()
  document.documentElement.className = ""
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
