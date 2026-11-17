import { afterEach, describe, expect, test } from "bun:test"
import { COLOR_KEYS, type Theme } from "@beadbox/server/theme-tokens"
import { applyTheme, clearTheme } from "../lib/theme-engine"
import darkJson from "../themes/beadbox-dark.json"

const theme = (over: Partial<Theme> = {}): Theme => ({
  id: "t",
  name: "T",
  appearance: "dark",
  colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, "#102030"])) as Theme["colors"],
  ...over,
})

afterEach(() => {
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
})

describe("applyTheme", () => {
  test("writes every colour token onto the element", () => {
    applyTheme(theme(), "dark")
    const s = document.documentElement.style
    for (const k of COLOR_KEYS) {
      const name = `--bb-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
      expect(s.getPropertyValue(name)).toBe("#102030")
    }
  })

  test("adds .dark for a dark theme", () => {
    applyTheme(theme({ appearance: "dark" }), "dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  test("removes .dark for a light theme", () => {
    document.documentElement.classList.add("dark")
    applyTheme(theme({ appearance: "light" }), "light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  test("writes optional radius and font tokens when present", () => {
    applyTheme(theme({ radius: { md: "0.5rem" }, fonts: { sans: "Inter, sans-serif" } }), "dark")
    const s = document.documentElement.style
    expect(s.getPropertyValue("--bb-radius-md")).toBe("0.5rem")
    expect(s.getPropertyValue("--bb-font-sans")).toBe("Inter, sans-serif")
  })

  test("omitted radius keys are not written, so the :root default wins", () => {
    applyTheme(theme({ radius: { md: "0.5rem" } }), "dark")
    expect(document.documentElement.style.getPropertyValue("--bb-radius-lg")).toBe("")
  })

  // Switching themes must not leak the previous theme's optional tokens.
  test("applying a theme without fonts clears a previous theme's fonts", () => {
    applyTheme(theme({ fonts: { sans: "Inter, sans-serif" } }), "dark")
    applyTheme(theme({ id: "u" }), "dark")
    expect(document.documentElement.style.getPropertyValue("--bb-font-sans")).toBe("")
  })

  test("clearTheme removes every token it set", () => {
    applyTheme(theme(), "dark")
    clearTheme()
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe("")
  })

  // Task 11 addendum: applyTheme now delegates the class toggle to
  // theme.ts's applyThemeClass instead of toggling the class itself, but
  // the ordering contract (tokens written, THEN class toggled) must be
  // unchanged — the status-colour MutationObserver is filtered to
  // attributeFilter: ["class"] and must only fire once tokens exist.
  test("toggles the class only after every token is written", () => {
    const el = document.createElement("div")
    const calls: string[] = []
    const originalSetProperty = el.style.setProperty.bind(el.style)
    el.style.setProperty = ((name: string, value: string) => {
      calls.push(`token:${name}`)
      return originalSetProperty(name, value)
    }) as typeof el.style.setProperty
    const originalToggle = el.classList.toggle.bind(el.classList)
    el.classList.toggle = ((name: string, force?: boolean) => {
      calls.push(`class:${name}`)
      return originalToggle(name, force)
    }) as typeof el.classList.toggle

    applyTheme(theme(), "dark", el)

    expect(calls.length).toBeGreaterThan(1)
    expect(calls[calls.length - 1]).toBe("class:dark")
    expect(calls.slice(0, -1).every((c) => c.startsWith("token:"))).toBe(true)
  })

  test("the class follows the appearance argument, not the theme's own field", () => {
    const el = document.createElement("div")
    const darkTheme = { ...darkJson, appearance: "dark" } as Theme

    applyTheme(darkTheme, "light", el)
    expect(el.classList.contains("dark")).toBe(false)

    applyTheme(darkTheme, "dark", el)
    expect(el.classList.contains("dark")).toBe(true)
  })

  test("tokens are still written before the class toggles", () => {
    const el = document.createElement("div")
    const order: string[] = []
    const realSet = el.style.setProperty.bind(el.style)
    el.style.setProperty = (k: string, v: string) => {
      order.push(`set:${k}`)
      realSet(k, v)
    }
    const realToggle = el.classList.toggle.bind(el.classList)
    el.classList.toggle = (c: string, f?: boolean) => {
      order.push("toggle")
      return realToggle(c, f)
    }

    applyTheme(darkJson as Theme, "dark", el)

    expect(order.at(-1)).toBe("toggle")
    expect(order.filter((o) => o === "toggle")).toHaveLength(1)
  })
})
