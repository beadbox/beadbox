// beadbox-knr: only Gray renders (index.css @theme declares the color tokens
// as gray literals, in every runtime), so a stored Blue or Green loads as
// Gray, and the stored preference is left as the user set it.

import { afterEach, describe, expect, test } from "bun:test"
import {
  AVAILABLE_THEMES,
  effectiveTheme,
  getThemePreference,
  setThemePreference,
} from "../lib/local-storage"
import { applyThemeClass } from "../lib/theme"

afterEach(() => {
  localStorage.clear()
  document.documentElement.className = ""
})

describe("theme availability", () => {
  test("only Gray is offered", () => {
    expect([...AVAILABLE_THEMES]).toEqual(["gray"])
  })

  test("a stored blue or green loads as gray; gray stays gray", () => {
    expect(effectiveTheme("blue")).toBe("gray")
    expect(effectiveTheme("green")).toBe("gray")
    expect(effectiveTheme("gray")).toBe("gray")
  })

  test("applying a stored blue puts the gray theme on <html>", () => {
    applyThemeClass(document.documentElement, "blue")
    expect(document.documentElement.className.split(" ").sort()).toEqual(["dark", "theme-gray"])
    applyThemeClass(document.documentElement, "green")
    expect(document.documentElement.className.split(" ").sort()).toEqual(["dark", "theme-gray"])
  })

  test("the stored preference is not rewritten", () => {
    setThemePreference("blue")
    applyThemeClass(document.documentElement, getThemePreference())
    expect(localStorage.getItem("beads-theme")).toBe("blue")
    expect(getThemePreference()).toBe("blue")
  })
})
