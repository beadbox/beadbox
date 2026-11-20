import { describe, expect, test } from "bun:test"
import { COLOR_KEYS } from "@beadbox/server/theme-tokens"
import { validateTheme } from "@beadbox/server/theme-validate"
import dark from "../themes/beadbox-dark.json"
import light from "../themes/beadbox-light.json"

// Contrast per WCAG 2.1 relative luminance.
function lum(hex: string): number {
  const h = hex.replace("#", "")
  const c = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255)
  const l = c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// The eight foreground/background pairs every theme must supply. Shared by
// every test below that walks "all eight pairs" so none of them can drift
// from what the others check.
const COLOR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["background", "foreground"],
  ["card", "cardForeground"],
  ["popover", "popoverForeground"],
  ["primary", "primaryForeground"],
  ["secondary", "secondaryForeground"],
  ["muted", "mutedForeground"],
  ["accent", "accentForeground"],
  ["destructive", "destructiveForeground"],
]

describe("built-in themes", () => {
  test("both validate", () => {
    expect(validateTheme(dark, { id: "beadbox-dark" }).ok).toBe(true)
    expect(validateTheme(light, { id: "beadbox-light" }).ok).toBe(true)
  })

  test("appearances are declared", () => {
    expect(dark.appearance).toBe("dark")
    expect(light.appearance).toBe("light")
  })

  test("every colour key is present in both", () => {
    for (const k of COLOR_KEYS) {
      expect(typeof (dark.colors as Record<string, string>)[k]).toBe("string")
      expect(typeof (light.colors as Record<string, string>)[k]).toBe("string")
    }
  })

  // Regression: the dormant palette had destructiveForeground === destructive.
  test("no foreground equals its own background", () => {
    for (const theme of [dark, light]) {
      const c = theme.colors as Record<string, string>
      for (const [bg, fg] of COLOR_PAIRS) {
        expect(c[bg]).not.toBe(c[fg])
      }
    }
  })

  test("light theme meets WCAG AA (4.5:1)", () => {
    const c = light.colors as Record<string, string>
    for (const [bg, fg] of COLOR_PAIRS) {
      expect(ratio(c[bg], c[fg])).toBeGreaterThanOrEqual(4.5)
    }
  })

  // beadbox-dark.json must reproduce the shipped 0.25.2+ palette byte-for-byte so that
  // selecting it is a visual no-op. Two pairs (destructive 3.44:1, muted 4.07:1) are below AA
  // in the shipped app today. Raising them would visibly restyle buttons (destructive would need
  // black text, impossible against #ef4444). That redesign is out of scope; this test guards
  // only that dark meets AA for large text and non-text UI (3:1), walking every pair against
  // that lower bar rather than a hand-picked subset.
  test("dark theme meets AA for large text (3:1); two pairs are pre-existing sub-AA", () => {
    const c = dark.colors as Record<string, string>
    for (const [bg, fg] of COLOR_PAIRS) {
      expect(ratio(c[bg], c[fg])).toBeGreaterThanOrEqual(3.0)
    }
  })
})
