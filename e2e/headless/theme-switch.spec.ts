// Task 14 (runtime themes): end-to-end check that the whole feature works in
// a real browser. Everything below this was unit-tested; nothing had yet
// driven the actual UI. Modeled on status-colors.spec.ts's conventions.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "../fixtures/harness"

const lightTheme = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "packages/client/src/themes/beadbox-light.json"), "utf-8"),
) as { id: string; colors: { background: string } }

const bbBackground = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bb-background").trim())

// Mirrors the setup in status-colors.spec.ts.
test.describe("theme switching", () => {
  test("switching to light flips appearance and recolours the surface", async ({ page }) => {
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

    // The regression that motivated the hybrid design: status colours must
    // follow the appearance change, not stay pinned to the dark surface.
    const surface = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--bb-card").trim(),
    )
    expect(surface).toBe("#ffffff")
  })

  test("body text stays readable against the background in light mode", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => localStorage.setItem("beads-theme", "beadbox-light"))
    await page.reload()

    const { bg, fg } = await page.evaluate(() => {
      const s = getComputedStyle(document.body)
      return { bg: s.backgroundColor, fg: s.color }
    })
    expect(bg).not.toBe(fg)
  })

  // Addendum: the startup-path tests above set localStorage and reload, which
  // only proves the app reads its preference correctly on boot. Theme state
  // used to live in independent useState copies per component, sharing only
  // localStorage; a pick made in the settings dialog would not reach the root
  // component that writes tokens to <html> until the next restart. Task 11
  // fixed that with a single observable store. Only a no-reload UI test
  // catches a regression in that wiring — a reload would still show the
  // right theme even if the live apply path were broken.
  test("picking Beadbox Light in the settings UI applies live, with no reload, and persists", async ({
    page,
  }) => {
    await page.goto("/")
    await expect(page.locator("html")).toHaveClass(/dark/)

    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const group = page.getByRole("radiogroup", { name: "Theme selection" })
    await expect(group).toBeVisible()

    await group.getByRole("radio", { name: "Beadbox Light theme" }).click()

    // Live, no reload: the appearance class and the token both flip at once.
    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(lightTheme.colors.background)

    await page.keyboard.press("Escape")

    // Persists across a reload too.
    await page.reload()
    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(lightTheme.colors.background)
  })

  // Addendum: keyboard selection is wired in the same picker (arrow keys plus
  // Enter/Space) — assert it applies live too, the same way the mouse path
  // does above.
  test("keyboard: arrowing to Beadbox Light and pressing Enter applies live", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator("html")).toHaveClass(/dark/)

    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const group = page.getByRole("radiogroup", { name: "Theme selection" })
    await group.getByRole("radio", { name: "Beadbox Dark theme" }).focus()
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("Enter")

    await expect(page.locator("html")).not.toHaveClass(/dark/)
    await expect.poll(() => bbBackground(page)).toBe(lightTheme.colors.background)
  })
})
