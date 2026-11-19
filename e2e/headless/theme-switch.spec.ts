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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "../fixtures/harness"
import { runPaths } from "../fixtures/run-paths"

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

// A user theme file, built from the real schema (packages/server/src/lib/
// theme-tokens.ts's COLOR_KEYS — see beadbox-light.json for the shape).
// validateTheme rejects a theme missing any one of these, so every key is
// given a value even though most of them are never asserted on.
// "background" is a colour that cannot collide with any built-in's, so a
// test that reads it cannot accidentally pass against a built-in theme.
const USER_THEME = {
  id: "e2e-user-theme",
  name: "E2E User Theme",
  appearance: "dark" as const,
  colors: {
    background: "#ff00ff",
    foreground: "#000000",
    card: "#ee00ee",
    cardForeground: "#000000",
    popover: "#ee00ee",
    popoverForeground: "#000000",
    primary: "#aa00aa",
    primaryForeground: "#ffffff",
    secondary: "#cc00cc",
    secondaryForeground: "#000000",
    muted: "#cc00cc",
    mutedForeground: "#330033",
    accent: "#cc00cc",
    accentForeground: "#000000",
    destructive: "#ff0000",
    destructiveForeground: "#ffffff",
    border: "#990099",
    input: "#990099",
    ring: "#aa00aa",
  },
}

// listThemeFiles() (packages/server/src/lib/theme-files.ts) reads from
// getThemesDir(), which falls back to `homedir()/.beadbox/themes` when
// BEADBOX_THEMES_PATH is unset. The sidecar (e2e/fixtures/harness.ts's
// `sidecar` fixture) is spawned with HOME: runPaths().home, so homedir()
// resolves to that scratch directory in the sidecar process — seeding a
// file here is what makes a user theme reach listThemeFiles() at all.
//
// runPaths().home is the whole RUN's scratch home (not per-worker), shared
// by every worker's sidecar — so this file is written once, in a serial
// describe block below, and removed in that block's afterAll rather than
// per-test, to avoid a write/delete race against a sibling test running in
// another worker.
function userThemesDir(): string {
  return join(runPaths().home, ".beadbox", "themes")
}
function userThemePath(): string {
  return join(userThemesDir(), `${USER_THEME.id}.json`)
}

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

    // This test otherwise does no UI interaction, so without this line it
    // would still pass against the "Startup error: test transport not
    // installed" screen (see the file-level comment above): theme tokens
    // are applied by a root effect that runs independently of the rest of
    // the app's render. The Settings button is part of the real app shell
    // only — the error screen (ErrorScreen in startup-gate.tsx) never
    // renders it — so asserting it first makes this test fail on its own
    // if the app did not actually boot.
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible()

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

// Nothing above
// this point ever seeds a user theme file, so listThemeFiles() always
// returns [] and every assertion above only ever exercises the two bundled
// themes — through a path (BUILTIN_ENTRIES) that short-circuits before any
// RPC. User-supplied theme files are the headline capability this feature
// exists for, and until now they had zero integration coverage: no test
// drove the directory read, the JSON parse, the sidecar hop, or
// validate-on-read.
//
// `mode: "serial"` keeps both tests in this block on one worker: the seeded
// file lives in runPaths().home, which every worker's sidecar shares (see
// the comment on userThemesDir() above), so a parallel sibling test here
// writing/removing the same path would race this one.
test.describe("user theme files from ~/.beadbox/themes", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeAll(() => {
    mkdirSync(userThemesDir(), { recursive: true })
    writeFileSync(userThemePath(), JSON.stringify(USER_THEME, null, 2))
  })

  test.afterAll(() => {
    rmSync(userThemePath(), { force: true })
  })

  test("a seeded user theme reaches the picker through the real directory-read -> parse -> validate -> sidecar -> RPC chain, in the grid matching its own appearance, and applies when selected", async ({
    page,
  }) => {
    await page.goto("/")
    // Default mode is dark (DEFAULT_THEME_PREFS), matching USER_THEME's
    // "dark" appearance, so selecting it needs no mode switch first.
    await expect(page.locator("html")).toHaveClass(/dark/)

    await openSettings(page)
    const darkSlot = page.getByRole("radiogroup", { name: "Dark theme", exact: true })
    const lightSlot = page.getByRole("radiogroup", { name: "Light theme", exact: true })

    // §6's slot-eligibility rule: a theme only ever appears in the grid for
    // its own `appearance`, never the other one. Assert the light grid itself
    // is present first — otherwise the toHaveCount(0) right below would pass
    // vacuously against a radiogroup that never rendered at all.
    await expect(lightSlot).toBeVisible()
    await expect(darkSlot.getByRole("radio", { name: "E2E User Theme theme" })).toBeVisible()
    await expect(lightSlot.getByRole("radio", { name: "E2E User Theme theme" })).toHaveCount(0)

    await darkSlot.getByRole("radio", { name: "E2E User Theme theme" }).click()

    // Proves the whole chain actually ran: a wrong read, a parse failure, a
    // failed validation, or a sidecar/RPC break would all leave this at the
    // built-in dark theme's background instead.
    await expect.poll(() => bbBackground(page)).toBe(USER_THEME.colors.background)
    await expect.poll(() => themePrefs(page)).toMatchObject({ darkThemeId: USER_THEME.id })
  })

  test("keyboard: arrow keys move focus between a grid's two cards and Enter selects the focused one, without disturbing the other grid", async ({
    page,
  }) => {
    await page.goto("/")
    await openSettings(page)

    const darkSlot = page.getByRole("radiogroup", { name: "Dark theme", exact: true })
    const lightSlot = page.getByRole("radiogroup", { name: "Light theme", exact: true })
    const darkDefault = darkSlot.getByRole("radio", { name: "Beadbox Dark theme" })
    const userCard = darkSlot.getByRole("radio", { name: "E2E User Theme theme" })
    // Light has only the one built-in card in this suite, so it is always
    // the light grid's sole (and thus already-focused) tab stop.
    const lightDefault = lightSlot.getByRole("radio", { name: "Beadbox Light theme" })

    await expect(darkDefault).toHaveAttribute("tabindex", "0")
    await expect(lightDefault).toHaveAttribute("tabindex", "0")

    await darkDefault.focus()
    await darkDefault.press("ArrowRight")

    await expect(userCard).toHaveAttribute("tabindex", "0")
    await expect(darkDefault).toHaveAttribute("tabindex", "-1")

    // The dark grid's own arrow-key navigation must not touch the light
    // grid's independent tab stop.
    await expect(lightDefault).toHaveAttribute("tabindex", "0")

    await userCard.press("Enter")

    await expect.poll(() => themePrefs(page)).toMatchObject({
      darkThemeId: USER_THEME.id,
      lightThemeId: "beadbox-light",
    })
  })
})
