// Task 14 (runtime themes) + beadbox-sdd/2026-11-17-appearance-mode task 6:
// end-to-end check the whole feature works in a real browser. Everything
// below was unit-tested; nothing had yet driven actual UI. Modeled on
// status-colors.spec.ts's conventions.
//
// Appearance is now a two-axis model: a MODE (dark / light / follow the
// system) plus a theme assigned to each of the dark and light slots. The
// settings UI reflects that split: an "Appearance mode" radiogroup, and two
// per-slot "Dark theme" / "Light theme" radiogroups of theme cards. Picking
// a mode is what flips the rendered appearance; picking a card in a slot
// only changes what that slot WOULD render, which only shows up once that
// slot's mode is active. Selecting a theme card used to flip appearance
// directly (single-axis model) — these tests exist to pin the new split so
// a regression back to one axis gets caught.
//
// IMPORTANT: import test/expect from "../fixtures/harness", never
// "@playwright/test" directly. Without the harness fixture,
// window.__beadboxTestBridge is never installed and the app renders a
// "Startup error: test transport not installed" screen — and theme
// assertions still pass against THAT screen, because tokens are applied by
// a root effect that runs independently of the rest of the app's render.
// An earlier version of this spec did exactly that: tests passing in under
// a second against an error shell.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "../fixtures/harness"

interface ThemeFixture {
  id: string
  colors: { background: string; card: string }
}

const lightTheme: ThemeFixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "packages/client/src/themes/beadbox-light.json"), "utf-8"),
)
const darkTheme: ThemeFixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "packages/client/src/themes/beadbox-dark.json"), "utf-8"),
)

const bbBackground = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bb-background").trim())

async function openSettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
}

function modeRadio(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("radiogroup", { name: "Appearance mode", exact: true }).getByRole("radio", { name })
}

function themePrefs(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("beads-theme-prefs")
    return raw ? JSON.parse(raw) : null
  })
}

// Mirrors setup in status-colors.spec.ts.
test.describe("theme switching", () => {
  test("legacy single-id preference migrates into the matching slot on boot", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator("html")).toHaveClass(/dark/)

    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)

    await page.evaluate(() => {
      localStorage.setItem("beads-theme", "beadbox-light")
    })
    await page.reload()

    await expect(page.locator("html")).not.toHaveClass(/dark/)

    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(lightBg).not.toBe(darkBg)

    // Proves applyTheme actually wrote the light theme's card token onto
    // <html> on the appearance change — not just that something about
    // status colours changed (that's currentThemeSurface/statusColorStore,
    // covered by unit tests in status-colors-mount.test.tsx /
    // project-status-colors.test.tsx).
    const surface = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--bb-card").trim(),
    )
    expect(surface).toBe(lightTheme.colors.card)
  })

  test("picking light mode in the settings UI applies live, with no reload, and persists", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator("html")).toHaveClass(/dark/)

    await openSettings(page)
    await expect(modeRadio(page, "light mode")).toBeVisible()
    await modeRadio(page, "light mode").click()

    // Live, no reload: the appearance class and the surface token both flip
    // at once.
    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(lightTheme.colors.background)

    await page.keyboard.press("Escape")

    // Persists across a reload too.
    await page.reload()
    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(lightTheme.colors.background)
  })

  test("assigning the dark slot while in light mode does not change the current appearance", async ({ page }) => {
    // Seed a stale (but validly-shaped) dark-slot id so clicking the
    // built-in dark card is an OBSERVABLE write, not a same-value no-op —
    // with only one dark-slot theme available in this harness, clicking
    // "Beadbox Dark theme" while darkThemeId is already "beadbox-dark"
    // would prove nothing either way.
    await page.goto("/")
    await page.evaluate(() => {
      localStorage.setItem(
        "beads-theme-prefs",
        JSON.stringify({ mode: "light", darkThemeId: "stale-dark-slot", lightThemeId: "beadbox-light" }),
      )
    })
    await page.reload()

    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(lightTheme.colors.background)

    await openSettings(page)
    const darkSlot = page.getByRole("radiogroup", { name: "Dark theme", exact: true })
    await expect(darkSlot).toBeVisible()
    await darkSlot.getByRole("radio", { name: "Beadbox Dark theme" }).click()

    // The write happened...
    await expect.poll(() => themePrefs(page)).toMatchObject({ mode: "light", darkThemeId: "beadbox-dark" })

    // ...but the current appearance is still light: the two-axis model's
    // whole point is that a slot assignment is inert until that slot's
    // mode is the active one. A single-axis regression would flip to dark
    // here.
    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(lightTheme.colors.background)

    // Switching to dark mode now applies the slot's assigned theme.
    await modeRadio(page, "dark mode").click()
    await expect(page.locator("html")).toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(darkTheme.colors.background)
  })

  test("system mode follows a live OS appearance change, with no reload", async ({ page }) => {
    // playwright.config has no default colorScheme, so Playwright starts
    // pages in "light" — choosing system mode here would already render
    // light before any emulation. Make every assertion a transition so a
    // startup-only read (rather than the live `change` listener) cannot
    // make this pass by accident.
    await page.goto("/")
    await openSettings(page)
    await modeRadio(page, "Follow system appearance").click()
    await page.keyboard.press("Escape")

    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(lightTheme.colors.background)

    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(darkTheme.colors.background)

    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(lightTheme.colors.background)
  })
})
