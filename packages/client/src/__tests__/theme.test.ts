// Rewritten for runtime themes. The previous version asserted gray-only
// rendering, which was the 0.25.2 limitation this feature removes.
import { afterEach, describe, expect, test } from "bun:test"
import {
  _resetThemePreferenceForTests,
  clearCache,
  clearLegacyThemeId,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  DEFAULT_THEME_PREFS,
  getLegacyThemeId,
  getThemePrefs,
  hasThemePrefs,
  resolveThemeId,
  setThemeForAppearance,
  setThemeMode,
  subscribeThemePreference,
} from "../lib/local-storage"
import { applyThemeClass } from "../lib/theme"

afterEach(() => {
  localStorage.clear()
  document.documentElement.className = ""
  _resetThemePreferenceForTests()
})

describe("resolveThemeId", () => {
  test("a known id returns itself", () => {
    expect(resolveThemeId("beadbox-light", ["beadbox-dark", "beadbox-light"], "light")).toBe(
      "beadbox-light",
    )
  })

  test("an unknown id falls back to the default for its own appearance", () => {
    // The fallback must land inside the
    // grid being rendered — an unresolvable id in the light grid must
    // resolve to the LIGHT default, not always the dark one, or no card
    // in that grid would ever show as selected.
    expect(resolveThemeId("nord", ["beadbox-dark", "beadbox-light"], "dark")).toBe(DEFAULT_THEME_ID)
    expect(resolveThemeId("nord", ["beadbox-light"], "light")).toBe(DEFAULT_LIGHT_THEME_ID)
  })

  test("storage is untouched either way", () => {
    setThemeForAppearance("dark", "nord")
    resolveThemeId("nord", ["beadbox-dark", "beadbox-light"], "dark")
    resolveThemeId("beadbox-dark", ["beadbox-dark", "beadbox-light"], "dark")
    expect(getThemePrefs().darkThemeId).toBe("nord")
  })
})

describe("clearCache", () => {
  test("after setThemeMode then clearCache, getThemePrefs returns the default without page reload", () => {
    setThemeMode("light")
    expect(getThemePrefs().mode).toBe("light")
    clearCache()
    expect(getThemePrefs()).toEqual(DEFAULT_THEME_PREFS)
  })

  test("a subscriber is notified by clearCache", () => {
    setThemeMode("light")
    let calls = 0
    const unsubscribe = subscribeThemePreference(() => {
      calls++
    })
    try {
      clearCache()
      expect(calls).toBe(1)
    } finally {
      unsubscribe()
    }
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

describe("theme prefs (appearance mode)", () => {
  test("defaults to dark mode with both built-in slots filled", () => {
    expect(getThemePrefs()).toEqual({
      mode: "dark",
      darkThemeId: "beadbox-dark",
      lightThemeId: "beadbox-light",
    })
  })

  test("getThemePrefs caches its parsed result for identity stability", () => {
    localStorage.setItem("beads-theme-prefs", JSON.stringify({ mode: "light" }))
    _resetThemePreferenceForTests()
    const first = getThemePrefs()
    const second = getThemePrefs()
    expect(first).toBe(second)
  })

  test("setThemeMode persists and notifies", () => {
    let calls = 0
    const un = subscribeThemePreference(() => {
      calls++
    })
    try {
      setThemeMode("system")
      expect(getThemePrefs().mode).toBe("system")
      expect(calls).toBe(1)
    } finally {
      un()
    }
  })

  test("setThemeForAppearance writes only the named slot", () => {
    setThemeForAppearance("light", "solarized")
    expect(getThemePrefs().lightThemeId).toBe("solarized")
    expect(getThemePrefs().darkThemeId).toBe("beadbox-dark")
  })

  test("an invalid mode and an invalid id are rejected without writing to storage or cache", () => {
    setThemeMode("neon" as never)
    expect(getThemePrefs().mode).toBe("dark")
    expect(localStorage.getItem("beads-theme-prefs")).toBeNull()

    setThemeForAppearance("dark", "../etc/passwd")
    expect(getThemePrefs().darkThemeId).toBe("beadbox-dark")
    expect(localStorage.getItem("beads-theme-prefs")).toBeNull()
  })

  test("a corrupt stored blob falls back to defaults rather than throwing", () => {
    localStorage.setItem("beads-theme-prefs", "{not json")
    _resetThemePreferenceForTests()
    expect(getThemePrefs()).toEqual(DEFAULT_THEME_PREFS)
  })

  test("a partial stored blob fills missing keys from defaults", () => {
    localStorage.setItem("beads-theme-prefs", JSON.stringify({ mode: "light" }))
    _resetThemePreferenceForTests()
    expect(getThemePrefs()).toEqual({
      mode: "light",
      darkThemeId: "beadbox-dark",
      lightThemeId: "beadbox-light",
    })
  })

  test("a stored blob that parses to a non-object value falls back per field, not caught as a whole", () => {
    for (const raw of ["42", '"hello"', "[]"]) {
      localStorage.setItem("beads-theme-prefs", raw)
      _resetThemePreferenceForTests()
      expect(getThemePrefs()).toEqual(DEFAULT_THEME_PREFS)
    }
  })

  test("a stored blob of JSON null is caught by the outer catch (null.mode throws)", () => {
    localStorage.setItem("beads-theme-prefs", "null")
    _resetThemePreferenceForTests()
    expect(getThemePrefs()).toEqual(DEFAULT_THEME_PREFS)
  })

  test("extra unknown keys in the stored blob are ignored", () => {
    localStorage.setItem(
      "beads-theme-prefs",
      JSON.stringify({ mode: "light", darkThemeId: "nord", somethingElse: "junk" }),
    )
    _resetThemePreferenceForTests()
    expect(getThemePrefs()).toEqual({
      mode: "light",
      darkThemeId: "nord",
      lightThemeId: "beadbox-light",
    })
  })

  test("writes still apply for the session when localStorage throws, and nothing lands in storage", () => {
    // Plain assignment (`localStorage.setItem = fn`) does NOT override the
    // method on Bun's Storage implementation, and `delete` cannot restore
    // it afterwards either ("Unable to delete property"), so the restore
    // redefines the property back to the real, bound original.
    const original = localStorage.setItem.bind(localStorage)
    Object.defineProperty(localStorage, "setItem", {
      value: () => {
        throw new Error("quota")
      },
      configurable: true,
      writable: true,
    })
    try {
      setThemeMode("light")
      expect(getThemePrefs().mode).toBe("light")
      expect(localStorage.getItem("beads-theme-prefs")).toBeNull()
    } finally {
      Object.defineProperty(localStorage, "setItem", {
        value: original,
        configurable: true,
        writable: true,
      })
    }
  })

  test("exposes and clears the legacy single-id key", () => {
    localStorage.setItem("beads-theme", "nord")
    expect(getLegacyThemeId()).toBe("nord")
    clearLegacyThemeId()
    expect(getLegacyThemeId()).toBeNull()
  })

  test("ignores a malformed legacy id", () => {
    localStorage.setItem("beads-theme", "../nope")
    expect(getLegacyThemeId()).toBeNull()
  })

  test("hasThemePrefs distinguishes never-written from migrated-to-defaults", () => {
    expect(hasThemePrefs()).toBe(false)

    setThemeMode("dark")
    expect(hasThemePrefs()).toBe(true)

    _resetThemePreferenceForTests()
    localStorage.clear()
    expect(hasThemePrefs()).toBe(false)
  })
})
