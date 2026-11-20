import { afterEach, describe, expect, test } from "bun:test"
import { THEME_SURFACES } from "../lib/status-colors"
import { currentThemeSurface } from "../lib/status-colors-store"

afterEach(() => {
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
})

describe("currentThemeSurface", () => {
  test("reads the active theme's --bb-card token", () => {
    document.documentElement.style.setProperty("--bb-card", "#27272a")
    expect(currentThemeSurface()).toBe("#27272a")
  })

  test("follows a theme switch, not a cached value", () => {
    document.documentElement.style.setProperty("--bb-card", "#27272a")
    expect(currentThemeSurface()).toBe("#27272a")
    document.documentElement.style.setProperty("--bb-card", "#ffffff")
    expect(currentThemeSurface()).toBe("#ffffff")
  })

  test("falls back to the gray card default when no token is set", () => {
    expect(currentThemeSurface()).toBe(THEME_SURFACES.gray.card)
  })

  test("is independent of theme-* classes, which Task 3 removed", () => {
    document.documentElement.classList.add("theme-green")
    document.documentElement.style.setProperty("--bb-card", "#101010")
    expect(currentThemeSurface()).toBe("#101010")
  })

  test("reads from an arbitrary element, not only documentElement", () => {
    const el = document.createElement("div")
    el.style.setProperty("--bb-card", "#abcdef")
    document.body.appendChild(el)
    expect(currentThemeSurface(el)).toBe("#abcdef")
    el.remove()
  })
})
