import { afterEach, describe, expect, test } from "bun:test"
import { probeTokenSupport } from "../lib/theme-engine"

afterEach(() => {
  document.documentElement.removeAttribute("style")
  document.querySelectorAll("[data-bb-probe]").forEach((n) => {
    n.remove()
  })
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
