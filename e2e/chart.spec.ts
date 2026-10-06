// Chart view (beadbox-eic). Like every e2e/*.spec.ts, this is ignored by
// playwright.config.ts until the suite is rewritten for the Tauri runtime; it
// records the end-to-end checks that rewrite should carry.

import type { Page } from "@playwright/test"
import { bd, bdCreate, expect, test } from "./fixtures/test-setup"
import { injectTauriMock } from "./fixtures/tauri-mock"

async function openApp(page: Page, workspaceId: string, path = "/") {
  await page.context().addCookies([{ name: "beads-workspace", value: workspaceId, domain: "localhost", path: "/" }])
  await page.goto(path)
  await expect(page.locator("header")).toBeVisible({ timeout: 15_000 })
}

const press5 = (page: Page) => page.keyboard.press(process.platform === "darwin" ? "Meta+5" : "Control+5")

test.describe("Chart view", () => {
  test.beforeEach(async ({ page }) => {
    await injectTauriMock(page)
  })

  for (const [view, path] of [
    ["Beads", "/"],
    ["Activity", "/activity"],
    ["Formulas", "/formulas"],
  ] as const) {
    test(`⌘5 opens the Chart view from ${view}`, async ({ page, testDb }) => {
      await openApp(page, testDb.workspaceId, path)
      await press5(page)
      await expect(page).toHaveURL(/\/chart$/)
      await expect(page.getByRole("heading", { name: "Chart" })).toBeVisible()
    })
  }

  test("lists the beads and opens one on the Beads view", async ({ page, testDb }) => {
    const epic = bdCreate(testDb.dbPath, ["--title", "Chart E2E Epic", "--type", "epic"])
    const task = bdCreate(testDb.dbPath, ["--title", "Chart E2E Task", "--parent", epic])
    await openApp(page, testDb.workspaceId, "/chart")

    const title = page.getByTestId("gantt-row-title").filter({ hasText: "Chart E2E Task" })
    await expect(title).toBeVisible({ timeout: 10_000 })
    await title.click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText(task).first()).toBeVisible()
  })

  test("closing a bead with bd turns its bar to the done style without a reload", async ({ page, testDb }) => {
    const epic = bdCreate(testDb.dbPath, ["--title", "Chart Live Epic", "--type", "epic"])
    const task = bdCreate(testDb.dbPath, ["--title", "Chart Live Task", "--parent", epic])
    await openApp(page, testDb.workspaceId, "/chart")

    const bar = page.locator(`[data-testid="gantt-bar"][data-bead-id="${task}"]`)
    await expect(bar).toHaveAttribute("data-style", "waiting hollow", { timeout: 10_000 })
    bd(testDb.dbPath, ["close", task])
    await expect(bar).toHaveAttribute("data-style", "done", { timeout: 15_000 })
  })
})
