import { test, expect, bd, bdCreate } from "./fixtures/test-setup"
import { injectTauriMock } from "./fixtures/tauri-mock"
import type { Page } from "@playwright/test"

// Shared helper: set workspace cookie, navigate to main page, wait for WS to connect.
async function setupWithWs(page: Page, workspaceId: string) {
  await page.context().addCookies([{
    name: "beads-workspace",
    value: workspaceId,
    domain: "localhost",
    path: "/",
  }])

  await page.goto("/")
  await expect(page.locator("header")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText("Epics")).toBeVisible({ timeout: 10_000 })
}

// Expand the test epic by clicking its chevron button
async function expandEpic(page: Page, epicName: string) {
  const epicRow = page.locator("[data-item-id]").filter({ hasText: epicName }).first()
  await epicRow.locator("button[type='button']").first().click()
  await expect(page.locator(".bead-row").first()).toBeVisible({ timeout: 10_000 })
}

test.describe("WebSocket real-time updates", () => {
  test.beforeEach(async ({ page }) => {
    await injectTauriMock(page)
  })

  // --- WebSocket connects via same-origin upgrade ---
  test("WebSocket connects on same port as page and no disconnect indicator shown", async ({ page, testDb }) => {
    await setupWithWs(page, testDb.workspaceId)

    // The red disconnect dot should NOT be visible when WS is connected
    const disconnectDot = page.locator("header span.rounded-full.bg-destructive")
    await expect(disconnectDot).not.toBeVisible({ timeout: 5_000 })
  })

  // --- Live bead update: status change reflected in UI ---
  test("bead status change via CLI updates UI without refresh", async ({ page, testDb }) => {
    await setupWithWs(page, testDb.workspaceId)
    await expandEpic(page, "E2E Test Epic")

    // "High Priority Task" starts as open. Verify it's visible.
    await expect(page.getByText("High Priority Task")).toBeVisible()

    // Get the ID of "High Priority Task" by listing beads
    const listOutput = bd(testDb.dbPath, ["list", "--json"])
    const beads = JSON.parse(listOutput)
    const highPriorityBead = beads.find((b: { title: string }) => b.title === "High Priority Task")
    expect(highPriorityBead).toBeTruthy()

    // Update the title via CLI (triggers poll -> WS broadcast -> UI refresh)
    bd(testDb.dbPath, ["update", highPriorityBead.id, "--title", "High Priority Task UPDATED"])

    // The updated title should appear in the UI without manual refresh
    await expect(page.getByText("High Priority Task UPDATED")).toBeVisible({ timeout: 10_000 })
  })

  // --- Live bead creation: new bead appears in UI ---
  test("new bead created via CLI appears in UI", async ({ page, testDb }) => {
    await setupWithWs(page, testDb.workspaceId)
    await expandEpic(page, "E2E Test Epic")

    // Count current bead rows
    const initialCount = await page.locator(".bead-row").count()

    // Get the epic ID for parenting
    const listOutput = bd(testDb.dbPath, ["list", "--json"])
    const beads = JSON.parse(listOutput)
    const epic = beads.find((b: { title: string }) => b.title === "E2E Test Epic")
    expect(epic).toBeTruthy()

    // Create a new bead via CLI under the epic
    bdCreate(testDb.dbPath, [
      "--title", "Live Created Bead", "--type", "task", "--priority", "2",
      "--parent", epic.id,
    ])

    // The new bead should appear without page refresh
    await expect(page.getByText("Live Created Bead")).toBeVisible({ timeout: 10_000 })
  })

  // --- Live bead deletion: bead disappears from UI ---
  test("deleted bead disappears from UI", async ({ page, testDb }) => {
    await setupWithWs(page, testDb.workspaceId)
    await expandEpic(page, "E2E Test Epic")

    // "Critical Bug" should be visible
    await expect(page.getByText("Critical Bug")).toBeVisible()

    // Get the ID
    const listOutput = bd(testDb.dbPath, ["list", "--json"])
    const beads = JSON.parse(listOutput)
    const criticalBug = beads.find((b: { title: string }) => b.title === "Critical Bug")
    expect(criticalBug).toBeTruthy()

    // Delete it via CLI
    bd(testDb.dbPath, ["delete", criticalBug.id, "--force"])

    // It should disappear without page refresh
    await expect(page.getByText("Critical Bug")).not.toBeVisible({ timeout: 10_000 })
  })

  // --- Disconnect indicator appears when WS is closed ---
  test("disconnect shows indicator, reconnect clears it", async ({ page, testDb }) => {
    // Inject a WS tracker before page loads so we can close connections later
    await page.addInitScript(() => {
      const OriginalWebSocket = window.WebSocket
      const instances: WebSocket[] = []
      ;(window as unknown as { _wsInstances: WebSocket[] })._wsInstances = instances
      window.WebSocket = function (url: string | URL, protocols?: string | string[]) {
        const ws = new OriginalWebSocket(url, protocols)
        instances.push(ws)
        return ws
      } as unknown as typeof WebSocket
      window.WebSocket.prototype = OriginalWebSocket.prototype
      Object.assign(window.WebSocket, OriginalWebSocket)
    })

    await setupWithWs(page, testDb.workspaceId)

    // Confirm connection is active (no red disconnect dot)
    const disconnectDot = page.locator("header span.rounded-full.bg-destructive")
    await expect(disconnectDot).not.toBeVisible({ timeout: 5_000 })

    // Close all WebSocket connections from the browser side
    await page.evaluate(() => {
      const instances = (window as unknown as { _wsInstances: WebSocket[] })._wsInstances
      instances.forEach((ws) => ws.close())
    })

    // Disconnect indicator: red dot should appear in header (wsConnected=false -> bg-red-500)
    await expect(disconnectDot).toBeVisible({ timeout: 5_000 })

    // The hook auto-reconnects with backoff. Wait for reconnection.
    // On reconnect wsConnected=true and the indicator section unmounts entirely.
    await expect(disconnectDot).not.toBeVisible({ timeout: 15_000 })
  })
})
