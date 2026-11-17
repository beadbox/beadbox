// beadbox-o3h: per-status colors. The pure half: default colors for custom
// statuses, the contrast rule, and the stylesheet the app injects.

import { describe, expect, test } from "bun:test"
import { getStatusDisplayConfig } from "../components/bead-detail-helpers"
import { getStatusConfig } from "../lib/badge-config"
import {
  BUILTIN_STATUSES,
  DEFAULT_PRIORITY_HEX,
  DEFAULT_STATUS_HEX,
  THEME_SURFACES,
  assignCustomDefaults,
  buildPriorityColorCss,
  buildStatusColorCss,
  contrastRatio,
  isGreyish,
  readableTextColor,
  resolveStatusColors,
} from "../lib/status-colors"

const CUSTOMS = [
  "waiting_on_nelson",
  "ready_for_qa",
  "in_qa",
  "qa_passed",
  "ready_to_ship",
  "in_review",
  "needs_design",
  "parked",
]

const builtinHexes = () => BUILTIN_STATUSES.map((s) => DEFAULT_STATUS_HEX[s])

describe("assignCustomDefaults", () => {
  test("every custom status gets a distinct color, none grey, none a built-in's", () => {
    const got = assignCustomDefaults(CUSTOMS)
    const values = CUSTOMS.map((c) => got[c])
    expect(values.every((v) => /^#[0-9a-f]{6}$/.test(v))).toBe(true)
    expect(new Set(values).size).toBe(values.length)
    for (const v of values) {
      expect(isGreyish(v)).toBe(false)
      expect(builtinHexes()).not.toContain(v)
    }
  })

  test("ready_for_qa and ready_to_ship keep today's purple and emerald", () => {
    const got = assignCustomDefaults(CUSTOMS)
    expect(got.ready_for_qa).toBe("#a855f7")
    expect(got.ready_to_ship).toBe("#10b981")
  })

  test("stays distinct well past the fixed palette", () => {
    const many = Array.from({ length: 40 }, (_, i) => `status_${i}`)
    const values = Object.values(assignCustomDefaults(many))
    expect(new Set(values).size).toBe(40)
    expect(values.some(isGreyish)).toBe(false)
  })

  test("never reuses a color the user chose for another status", () => {
    const plain = assignCustomDefaults(["waiting_on_nelson", "in_qa"])
    const taken = plain.in_qa
    const got = assignCustomDefaults(["waiting_on_nelson", "in_qa"], { open: taken })
    expect(got.in_qa).not.toBe(taken)
    expect(got.waiting_on_nelson).not.toBe(taken)
  })

  test("stable for the same input; adding a status (appended, as Settings does) leaves the rest alone", () => {
    const a = assignCustomDefaults(CUSTOMS)
    expect(assignCustomDefaults([...CUSTOMS])).toEqual(a)
    const added = assignCustomDefaults([...CUSTOMS, "brand_new"])
    for (const c of CUSTOMS) expect(added[c]).toBe(a[c])
    // Removing one never changes the statuses listed before it.
    const idx = CUSTOMS.indexOf("in_review")
    const removed = assignCustomDefaults(CUSTOMS.filter((c) => c !== "in_review"))
    for (const c of CUSTOMS.slice(0, idx)) expect(removed[c]).toBe(a[c])
  })
})

describe("readableTextColor", () => {
  const hues = [
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#000080",
    "#111111",
    "#000000",
    "#ffff00",
    "#ffffff",
    "#7f1d1d",
    "#3b0764",
    "#808080",
    "#f59e0b",
  ]
  for (const [theme, surfaces] of Object.entries(THEME_SURFACES)) {
    for (const surfaceName of ["background", "card"] as const) {
      const surface = surfaces[surfaceName]
      test(`>= 4.5:1 on the color's own 20% tint over ${theme} ${surfaceName}`, () => {
        for (const hex of hues) {
          const text = readableTextColor(hex, surface)
          const tint = mix(hex, surface, 0.2)
          expect({ hex, ratio: contrastRatio(text, tint) >= 4.5 }).toEqual({ hex, ratio: true })
        }
      })
    }
  }

  test("contrastRatio matches WCAG for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1)
  })
})

describe("resolveStatusColors", () => {
  // REVERSED by the light-theme palette sweep. This previously asserted
  // `css` was empty, because a built-in with no chosen colour kept the
  // hardcoded Tailwind classes each surface carried. Those classes are
  // dark-only (`text-amber-400` on a white card fails contrast), so every
  // status now emits a rule and gets readableTextColor's per-surface text.
  test("built-ins with no chosen color now emit CSS, at their default hex", () => {
    const statuses = [...BUILTIN_STATUSES, "ready_for_qa", "ready_to_ship"]
    const { css } = resolveStatusColors(statuses, {})
    for (const s of statuses) {
      expect(css[s]).toBe(DEFAULT_STATUS_HEX[s])
    }
  })

  test("open's default follows the theme foreground, not a baked #ffffff", () => {
    // The bug this fixes: #ffffff tinted 20% over a white card is white —
    // contrast 1.00, an invisible badge in every light theme.
    const dark = resolveStatusColors(["open"], {}, [], { foreground: "#f4f4f5" })
    const light = resolveStatusColors(["open"], {}, [], { foreground: "#0a0a0a" })
    expect(dark.css.open).toBe("#f4f4f5")
    expect(light.css.open).toBe("#0a0a0a")
    // Absent/garbage foreground falls back to the dark literal.
    expect(resolveStatusColors(["open"], {}, []).css.open).toBe("#ffffff")
    expect(resolveStatusColors(["open"], {}, [], { foreground: "nope" }).css.open).toBe("#ffffff")
  })

  test("a chosen color applies; a generated default applies to other customs", () => {
    const { css, display } = resolveStatusColors([...BUILTIN_STATUSES, "waiting_on_nelson"], {
      open: "#ff0000",
    })
    expect(css.open).toBe("#ff0000")
    expect(css.waiting_on_nelson).toMatch(/^#[0-9a-f]{6}$/)
    expect(display.in_progress).toBe(DEFAULT_STATUS_HEX.in_progress)
  })

  test("bd built-ins beyond the five (pinned, hooked on bd 1.3) are built-ins: today's blue", () => {
    // bd 1.3.1 lists pinned and hooked as built-ins; only status.custom is custom.
    // They now emit CSS too (see the reversal above), still at FALLBACK_HEX,
    // so they keep looking like the blue every surface fell back to.
    const statuses = [...BUILTIN_STATUSES, "pinned", "hooked", "waiting_on_nelson"]
    const { css, display } = resolveStatusColors(statuses, {}, ["waiting_on_nelson"])
    expect(css.pinned).toBe("#3b82f6")
    expect(css.hooked).toBe("#3b82f6")
    expect(display.pinned).toBe("#3b82f6")
    expect(css.waiting_on_nelson).toMatch(/^#[0-9a-f]{6}$/)
    // and a chosen color still applies to one
    expect(resolveStatusColors(statuses, { hooked: "#ff0000" }, ["waiting_on_nelson"]).css.hooked).toBe("#ff0000")
  })

  test("a color for a status no longer in the project is ignored", () => {
    const { css, display } = resolveStatusColors([...BUILTIN_STATUSES], { gone_status: "#ff0000" })
    expect(css.gone_status).toBeUndefined()
    expect(display.gone_status).toBeUndefined()
  })
})

describe("buildStatusColorCss", () => {
  test("one rule per role per status, values from the hex only", () => {
    const out = buildStatusColorCss({ open: "#ff0000" }, THEME_SURFACES.blue.background)
    expect(out).toContain('[data-status="open"][data-status-role="badge"]')
    expect(out).toContain('[data-status="open"][data-status-role="dot"]')
    expect(out).toContain('[data-status="open"][data-status-role="text"]')
    expect(out).toContain('[data-status="open"][data-status-role="stage"]')
    expect(out).toContain("rgb(255 0 0 / 0.2)")
  })

  test("a hostile status name cannot break out of the selector", () => {
    const out = buildStatusColorCss({ 'x"] {} body { display:none } [a="': "#ff0000" }, "#000000")
    expect(out).not.toContain("body {")
    expect(out.split("{").length).toBe(out.split("}").length)
  })

  test("a non-hex value never reaches the stylesheet", () => {
    expect(buildStatusColorCss({ open: "red; background:url(x)" }, "#000000")).toBe("")
  })

  // beadbox-t6x: the All projects view styles each project's rows with that
  // project's own colors, so its rules are scoped to the project's elements.
  test("a scope confines every rule to that project's elements", () => {
    const colors = { open: "#ff0000", review: "#00aa00" }
    const unscoped = buildStatusColorCss(colors, "#000000")
    const scoped = buildStatusColorCss(colors, "#000000", "ws-a")
    const rules = scoped.split("\n")
    expect(rules.length).toBe(unscoped.split("\n").length)
    for (const rule of rules) expect(rule.startsWith('[data-project-id="ws-a"] [data-status=')).toBe(true)
    // Same declarations as the unscoped sheet, only the selector differs.
    expect(scoped.replaceAll('[data-project-id="ws-a"] ', "")).toBe(unscoped)
  })

  test("a hostile workspace id cannot break out of the scope", () => {
    const out = buildStatusColorCss({ open: "#ff0000" }, "#000000", 'a"] , body { x:y } [b="')
    expect(out).not.toContain("body {")
    expect(out.split("{").length).toBe(out.split("}").length)
    expect(out.split("\n").every((r) => r.startsWith('[data-project-id="'))).toBe(true)
  })

  test("without a scope the sheet is unchanged", () => {
    expect(buildStatusColorCss({ open: "#ff0000" }, "#000000", undefined)).toBe(
      buildStatusColorCss({ open: "#ff0000" }, "#000000"),
    )
  })
})

describe("unchanged defaults (main @ 89cf7f18)", () => {
  // This block used to pin the literal palette classes, to prove the o3h
  // status-colour work changed nothing about the look. The light-theme sweep
  // changes it ON PURPOSE: those literals are dark-only, and the badge's
  // actual colour now comes from the unlayered stylesheet. What is pinned
  // here instead is that the PRE-STYLESHEET fallback is tokenised — no
  // palette literal may come back, or a light theme shows amber-on-white
  // during the window before the custom-status list loads.
  test("badge fallback classes are tokenised, with no palette literal left", () => {
    expect(getStatusConfig("open").className).toBe(
      "bg-foreground/10 text-foreground border-foreground/30",
    )
    expect(getStatusConfig("in_progress").className).toBe(
      "bg-warning/20 text-warning-text border-warning/40",
    )
    expect(getStatusConfig("closed").className).toBe(
      "bg-muted/40 text-muted-foreground border-border",
    )
    // blocked / deferred have no config of their own and take the fallback.
    expect(getStatusConfig("blocked").className).toBe("bg-info/20 text-info-text border-info/40")
    expect(getStatusConfig("deferred").className).toBe("bg-info/20 text-info-text border-info/40")
    expect(getStatusConfig("ready_for_qa").className).toBe(
      "bg-info/20 text-info-text border-info/40",
    )

    const PALETTE =
      /-(slate|zinc|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/
    for (const s of ["open", "in_progress", "closed", "blocked", "ready_for_qa", "nonesuch"]) {
      expect(getStatusConfig(s).className).not.toMatch(PALETTE)
    }
  })

  // Same reversal as the badge classes above: the real colour comes from the
  // stylesheet's "text" and "dot" roles, so what is pinned is that the
  // fallback is tokenised.
  test("detail-panel fallback classes are tokenised", () => {
    expect(getStatusDisplayConfig("open")).toMatchObject({
      colorClass: "text-foreground",
      dotClass: "bg-foreground",
    })
    expect(getStatusDisplayConfig("in_progress")).toMatchObject({
      colorClass: "text-warning-text",
      dotClass: "bg-warning",
    })
    // blocked has no config of its own and takes the fallback.
    expect(getStatusDisplayConfig("blocked")).toMatchObject({
      colorClass: "text-info-text",
      dotClass: "bg-info",
    })

    const PALETTE =
      /-(slate|zinc|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/
    for (const s of ["open", "in_progress", "closed", "ready_to_ship", "nonesuch"]) {
      const c = getStatusDisplayConfig(s)
      expect(c.colorClass).not.toMatch(PALETTE)
      expect(c.dotClass).not.toMatch(PALETTE)
    }
  })
})

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => Number.parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => Number.parseInt(b.slice(i, i + 2), 16))
  return `#${pa
    .map((v, i) =>
      Math.round(v * t + pb[i] * (1 - t))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

describe("buildPriorityColorCss", () => {
  const DARK = "#27272a"
  const LIGHT = "#ffffff"

  test("emits a rule set for all five priorities", () => {
    const css = buildPriorityColorCss(DARK)
    for (const p of ["critical", "high", "medium", "low", "backlog"]) {
      expect(css).toContain(`[data-priority="${p}"][data-priority-role="badge"]`)
    }
  })

  test("keeps the alpha ramp the hardcoded classes carried", () => {
    const css = buildPriorityColorCss(DARK)
    // P0 filled at /20 (#ef4444), P2 at half that (#eab308).
    expect(css).toContain("rgb(239 68 68 / 0.2)")
    expect(css).toContain("rgb(234 179 8 / 0.1)")
  })

  // The reason priorities go through the machinery at all.
  test("derives different badge text per surface", () => {
    const dark = buildPriorityColorCss(DARK)
    const light = buildPriorityColorCss(LIGHT)
    expect(dark).not.toBe(light)
    for (const hex of Object.values(DEFAULT_PRIORITY_HEX)) {
      const d = readableTextColor(hex, DARK)
      const l = readableTextColor(hex, LIGHT)
      expect(dark).toContain(`color:${d}`)
      expect(light).toContain(`color:${l}`)
      expect(d).not.toBe(l)
    }
  })

  test("the fill itself is appearance-independent, only the text moves", () => {
    // Priorities are not user-configurable, so the hue is fixed; what a light
    // theme needs is the text, not a different fill.
    expect(buildPriorityColorCss(LIGHT)).toContain("rgb(239 68 68 / 0.2)")
  })
})
