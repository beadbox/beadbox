// Rewritten for runtime themes. The previous version asserted gray-only
// rendering, which was the 0.25.2 limitation this feature removes.
import { afterEach, describe, expect, test } from "bun:test"
import {
  _resetThemePreferenceForTests,
  clearCache,
  clearLegacyThemeId,
  DEFAULT_THEME_ID,
  DEFAULT_THEME_PREFS,
  getLegacyThemeId,
  getThemePreference,
  getThemePrefs,
  resolveThemeId,
  setThemeForAppearance,
  setThemeMode,
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

describe("clearCache", () => {
  test("after setThemePreference then clearCache, getThemePreference returns the default without page reload", () => {
    setThemePreference("nord")
    expect(getThemePreference()).toBe("nord")
    clearCache()
    expect(getThemePreference()).toBe(DEFAULT_THEME_ID)
  })

  test("a subscriber is notified by clearCache", () => {
    setThemePreference("nord")
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

  test("rejects an invalid mode and an invalid id without writing", () => {
    setThemeMode("neon" as never)
    expect(getThemePrefs().mode).toBe("dark")
    setThemeForAppearance("dark", "../etc/passwd")
    expect(getThemePrefs().darkThemeId).toBe("beadbox-dark")
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

  test("writes still apply for the session when localStorage throws", () => {
    const original = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error("quota")
    }
    try {
      setThemeMode("light")
      expect(getThemePrefs().mode).toBe("light")
    } finally {
      localStorage.setItem = original
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
})
