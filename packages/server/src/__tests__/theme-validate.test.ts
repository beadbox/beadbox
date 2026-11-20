import { describe, expect, test } from "bun:test"
import { COLOR_KEYS, cssVarName, TONE_KEYS, toneTextVarName } from "../lib/theme-tokens"
import { validateTheme } from "../lib/theme-validate"

const colors = () =>
  Object.fromEntries(COLOR_KEYS.map((k) => [k, "#101010"])) as Record<string, string>
const base = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "nord",
  name: "Nord",
  appearance: "dark" as const,
  colors: colors(),
  ...over,
})

describe("cssVarName", () => {
  test("camelCase becomes kebab-case with the --bb- prefix", () => {
    expect(cssVarName("background")).toBe("--bb-background")
    expect(cssVarName("cardForeground")).toBe("--bb-card-foreground")
    expect(cssVarName("destructiveForeground")).toBe("--bb-destructive-foreground")
  })
})

describe("validateTheme", () => {
  test("accepts a complete theme", () => {
    const r = validateTheme(base())
    expect(r.ok).toBe(true)
  })

  test("accepts rgb() colours", () => {
    const r = validateTheme(base({ colors: colors() }))
    expect(r.ok).toBe(true)
    const r2 = validateTheme(base({ colors: { ...colors(), background: "rgb(1, 2, 3)" } }))
    expect(r2.ok).toBe(true)
  })

  test("rejects oklch and names the key", () => {
    const r = validateTheme(base({ colors: { ...colors(), background: "oklch(1 0 0)" } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("colors.background")
  })

  test("rejects color-mix", () => {
    const r = validateTheme(
      base({ colors: { ...colors(), ring: "color-mix(in srgb, red, blue)" } }),
    )
    expect(r.ok).toBe(false)
  })

  test("rejects a missing colour key and names it", () => {
    const c = colors()
    delete (c as Record<string, string>).ring
    const r = validateTheme(base({ colors: c }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("ring")
  })

  test("rejects an unknown colour key", () => {
    const r = validateTheme(base({ colors: { ...colors(), bogus: "#fff" } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("bogus")
  })

  test("requires appearance to be dark or light", () => {
    expect(validateTheme(base({ appearance: "neon" })).ok).toBe(false)
    expect(validateTheme(base({ appearance: undefined })).ok).toBe(false)
  })

  test("radius and fonts are optional", () => {
    expect(validateTheme(base({ radius: undefined, fonts: undefined })).ok).toBe(true)
    expect(validateTheme(base({ radius: { md: "0.5rem" } })).ok).toBe(true)
  })

  test("rejects a radius value containing CSS punctuation", () => {
    const r = validateTheme(base({ radius: { md: "1rem; } body { display:none" } }))
    expect(r.ok).toBe(false)
  })

  test("rejects an id that does not match the expected filename stem", () => {
    const r = validateTheme(base({ id: "nord" }), { id: "arctic" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("id")
  })
})

describe("tone colour tokens", () => {
  test("toneTextVarName names the derived companion", () => {
    expect(toneTextVarName("warning")).toBe("--bb-warning-text")
    expect(toneTextVarName("success")).toBe("--bb-success-text")
  })

  // Backwards compatibility: every theme file written before tone tokens
  // existed omits all three, and must stay valid.
  test("a theme omitting every tone is still valid", () => {
    const r = validateTheme(base())
    expect(r.ok).toBe(true)
  })

  test("accepts authored tones, hex and rgb()", () => {
    const r = validateTheme(
      base({ colors: { ...colors(), warning: "#ff8800", info: "rgb(1, 2, 3)" } }),
    )
    expect(r.ok).toBe(true)
  })

  test("rejects a present-but-malformed tone", () => {
    for (const k of TONE_KEYS) {
      const r = validateTheme(base({ colors: { ...colors(), [k]: "goldenrod" } }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(`colors.${k}`)
    }
  })

  test("still rejects a genuinely unknown colour key", () => {
    const r = validateTheme(base({ colors: { ...colors(), chartreuse: "#010101" } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("not a known colour token")
  })
})
