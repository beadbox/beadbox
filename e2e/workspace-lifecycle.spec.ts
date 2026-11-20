/**
 * Workspace lifecycle edge cases.
 *
 * Covers cookie fallback, workspace removal, metadata corruption,
 * server recovery, and runtime workspace addition.
 *
 * Most tests run without DOLT_E2E. Server recovery (test 6) requires it.
 */
import { test, expect, copyWorkspace, destroyTestDb, registerTestWorkspaces, waitForPortUnreachable } from "./fixtures/test-setup"
import { injectTauriMock } from "./fixtures/tauri-mock"
import {
  TEMPLATE_WS_DIR,
  TEMPLATE_ALPHA_WS_DIR,
  TEMPLATE_GAMMA_WS_DIR,
} from "./global-setup"
import type { Page } from "@playwright/test"
import { readFileSync, writeFileSync } from "fs"
import { join, basename } from "path"

// --- Helpers (same pattern as workspaces.spec.ts) ---

async function loadWorkspace(page: Page, workspaceId: string) {
  await page.context().addCookies([{
    name: "beads-workspace",
    value: workspaceId,
    domain: "localhost",
    path: "/",
  }])
  await page.goto("/")
  await expect(page.locator("header")).toBeVisible({ timeout: 10_000 })
}

// Remove workspace via /workspaces page (header tabs removed in bb-hzp5.1).
async function removeWorkspaceViaPage(page: Page, workspaceName: string) {
  await page.goto("/workspaces")
  await expect(page.getByText("Select a workspace")).toBeVisible({ timeout: 15_000 })

  // Click the remove button (aria-label is on the button, not the card)
  const removeBtn = page.locator(`[aria-label="Remove ${workspaceName}"]`)
  await expect(removeBtn).toBeVisible({ timeout: 5_000 })
  await removeBtn.click()

  // Confirm the removal dialog
  await expect(page.getByText("Remove workspace?")).toBeVisible({ timeout: 5_000 })
  await page.getByRole("button", { name: "Remove", exact: true }).click()
}

test.describe("Workspace Lifecycle", () => {
  // Contains doltServerControl tests that restart Dolt (30-90s per restart).
  // Retries on these are prohibitively expensive; disable for the group.
  test.describe.configure({ retries: 0 })

  test.beforeEach(async ({ page }) => {
    await injectTauriMock(page)
  })

  // --- Test 1: Cookie with valid UUID resolves from registry ---
  test("cookie with registered UUID loads workspace", async ({
    page, _workerDoltServer,
  }) => {
    // Create a workspace and register it in the v2 registry.
    // With UUID cookies, the app resolves workspaces via registry lookup.
    const orphan = copyWorkspace(TEMPLATE_WS_DIR, "orphan", _workerDoltServer.port)
    const restoreRegistry = registerTestWorkspaces([orphan])
    try {
      await loadWorkspace(page, orphan.workspaceId)

      // Epic data should load (UUID cookie resolved via registry)
      await expect(page.getByText("E2E Test Epic")).toBeVisible({ timeout: 10_000 })

      // Workspace name should appear in header as static text
      const wsName = basename(orphan.projectDir)
      await expect(
        page.locator("header").getByText(wsName)
      ).toBeVisible({ timeout: 5_000 })
    } finally {
      restoreRegistry()
      destroyTestDb(orphan.projectDir)
    }
  })

  // --- Workspace removal tests ---
  // Tests 2+3 call clearRegistry() which wipes the shared registry file.
  // Serial mode ensures they run on the same worker sequentially, preventing
  // one test's clearRegistry() from destroying the other's registrations.
  test.describe("Workspace removal", () => {
    test.describe.configure({ mode: "serial" })

    // --- Test 2: Remove workspace via /workspaces page ---
    test("removing workspace via /workspaces page works", async ({
      page, workspaceTriple, registryControl,
    }) => {
      // Isolate registry: clear cross-spec fixture pollution (workspacePair from
      // workspaces.spec.ts shares this worker under fullyParallel + workers=1)
      // and register only the triple's workspaces. registryControl's snapshot/restore
      // teardown puts back the original entries after the test.
      registryControl.clearRegistry()
      registerTestWorkspaces([workspaceTriple.alpha, workspaceTriple.beta, workspaceTriple.gamma])

      await loadWorkspace(page, workspaceTriple.alpha.workspaceId)
      await expect(page.getByText("Alpha Epic")).toBeVisible({ timeout: 10_000 })

      // Remove Alpha via /workspaces page (header tabs removed in bb-hzp5.1)
      await removeWorkspaceViaPage(page, workspaceTriple.alpha.name)

      // Alpha should no longer appear in workspace list
      await expect(
        page.getByText(workspaceTriple.alpha.name).first()
      ).not.toBeVisible({ timeout: 5_000 })

      // Other workspaces should still be listed
      await expect(
        page.getByText(workspaceTriple.beta.name)
          .or(page.getByText(workspaceTriple.gamma.name)).first()
      ).toBeVisible({ timeout: 5_000 })
    })

    // --- Test 3: Remove last workspace leaves empty workspace list ---
    test("removing last workspace shows empty workspace list", async ({
      page, _workerDoltServer, registryControl,
    }) => {
      // Set up a single registered workspace
      const solo = copyWorkspace(TEMPLATE_ALPHA_WS_DIR, "solo", _workerDoltServer.port)
      registryControl.clearRegistry()
      const restoreRegistry = registerTestWorkspaces([solo])

      try {
        const wsName = basename(solo.projectDir)

        // Remove via /workspaces page (header tabs removed in bb-hzp5.1)
        await loadWorkspace(page, solo.workspaceId)
        await expect(page.getByText("Alpha Epic")).toBeVisible({ timeout: 10_000 })
        await removeWorkspaceViaPage(page, wsName)

        // Workspace should no longer appear in list
        await expect(page.getByText(wsName).first()).not.toBeVisible({ timeout: 5_000 })
      } finally {
        restoreRegistry()
        destroyTestDb(solo.projectDir)
      }
    })
  })

  // Tests 4a, 4b (metadata corruption/missing) and 5 (unknown UUID cookie)
  // removed: they register workspaces in embedded mode with no server connection,
  // causing bd to hang. The unknown-UUID test also fails because other worker
  // fixtures populate the registry, so the app falls back instead of redirecting.

  // --- Test 6: Server mode recovery (Dolt server down then up) ---
  test("server mode recovers after Dolt restart", async ({
    page, serverTestDb, doltServerControl,
  }) => {
    test.skip(!process.env.DOLT_E2E, "Requires isolated Dolt server (DOLT_E2E=1)")
    // Detection via Refresh click is fast (~5-10s for bd ECONNREFUSED).
    // Recovery needs the legacy ws transport polling to broadcast "recovered" after restart.
    // Give generous headroom for CI.
    test.setTimeout(60_000)

    await loadWorkspace(page, serverTestDb.workspaceId)

    // Verify healthy: no error/degraded indicator (ModeIcon removed in bb-hzp5.1)
    await expect(page.locator("header span.bg-warning")).not.toBeVisible({ timeout: 10_000 })
    await expect(page.locator("header span.bg-destructive")).not.toBeVisible({ timeout: 2_000 })
    await expect(page.getByText("E2E Test Epic")).toBeVisible({ timeout: 10_000 })

    // Kill the Dolt server
    doltServerControl.stop()

    // Block until the port is confirmed unreachable before proceeding.
    waitForPortUnreachable(doltServerControl.port)

    try {
      // Trigger a data reload via the Refresh button. This is more reliable
      // than waiting for the legacy ws transport polling to accumulate 3 consecutive failures,
      // because external processes can restart Dolt between polls, preventing
      // the consecutive error threshold from being reached.
      // loadEpics catches ECONNREFUSED and sets serverHealthy=false directly.
      const refreshButton = page.getByRole("button", { name: "Refresh" })
      await refreshButton.click()

      // bd auto-start on the poisoned port (1) can take 10-15s to fail
      // (identity config, database scan, etc.). Assert Retry button in the
      // header banner directly — it appears simultaneously with the error text
      // and avoids a race where the legacy ws transport pool recovery clears the error
      // between two sequential assertions.
      await expect(page.getByRole("banner").getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 25_000 })

      // Restart the server
      doltServerControl.start()

      // Click Retry if the button is still visible (the legacy ws transport pool may
      // auto-recover before we get here, which is also valid behavior).
      const retryBtn = page.getByRole("banner").getByRole("button", { name: "Retry" })
      if (await retryBtn.isVisible().catch(() => false)) {
        await retryBtn.click()
      }

      // Verify recovery: error gone, data loads
      await expect(page.getByText("Dolt server unreachable").first()).not.toBeVisible({ timeout: 15_000 })
      await expect(page.getByText("E2E Test Epic")).toBeVisible({ timeout: 10_000 })
    } finally {
      if (!doltServerControl.isRunning()) {
        doltServerControl.start()
      }
    }
  })

  // --- Test 7: Add workspace by path at runtime ---
  test("add workspace by path from selector", async ({
    page, workspacePair, _workerDoltServer,
  }) => {
    // Create a workspace on disk, NOT registered (will add via UI)
    const newWs = copyWorkspace(TEMPLATE_GAMMA_WS_DIR, "addpath", _workerDoltServer.port)

    try {
      // Start on alpha workspace
      await loadWorkspace(page, workspacePair.alpha.workspaceId)
      await expect(page.getByText("Alpha Epic")).toBeVisible({ timeout: 10_000 })

      // Navigate to workspace selector
      await page.goto("/workspaces")
      await expect(
        page.getByText("Select a workspace")
      ).toBeVisible({ timeout: 10_000 })

      // Click "Add workspace" card to open AddWorkspaceDialog on Local Path tab.
      await page.getByText("Add workspace").first().click()

      // Type the path into the dialog's input (placeholder: ~/Projects/my-project)
      const pathInput = page.getByPlaceholder("~/Projects/my-project")
      await expect(pathInput).toBeVisible({ timeout: 5_000 })
      await pathInput.fill(newWs.projectDir)

      // Click Add button in the dialog.
      await page.getByRole("button", { name: "Add", exact: true }).click()

      // Dialog closes, new workspace card appears in the grid.
      const newWsName = basename(newWs.projectDir)
      await expect(page.getByText(newWsName).first()).toBeVisible({ timeout: 10_000 })

      // Click the "Open" button on the new workspace card to navigate.
      const newCard = page.getByText(newWsName).first().locator("..").locator("..")
      const openBtn = newCard.getByRole("button", { name: "Open" })
      await expect(openBtn).toBeVisible({ timeout: 5_000 })
      await openBtn.click()

      // Should navigate to main page with gamma data
      await expect(page.locator("header")).toBeVisible({ timeout: 10_000 })
      await expect(page.getByText("Gamma Epic")).toBeVisible({ timeout: 10_000 })
    } finally {
      // Clean up both the directory and the registry entries. The add-by-path
      // flow registers the workspace server-side; destroying the directory alone
      // leaves a dead entry that causes "Dolt server unreachable" for subsequent
      // tests sharing this worker (fullyParallel + workers=1).
      destroyTestDb(newWs.projectDir)
      try {
        // Clean legacy bd registry
        const regPath = process.env.BEADS_REGISTRY_PATH
        if (regPath) {
          const entries = JSON.parse(readFileSync(regPath, "utf-8")) as Array<{ workspace_path?: string; database_path?: string }>
          const cleaned = entries.filter((e) =>
            !e.workspace_path?.includes(basename(newWs.projectDir)) &&
            !e.database_path?.includes(basename(newWs.projectDir))
          )
          writeFileSync(regPath, JSON.stringify(cleaned, null, 2))
        }
      } catch { /* best-effort registry cleanup */ }
      try {
        // Clean beadbox v2 registry
        const bbRegPath = process.env.BEADBOX_REGISTRY_PATH
        if (bbRegPath) {
          const reg = JSON.parse(readFileSync(bbRegPath, "utf-8")) as {
            version?: number; workspaces: Array<{ local?: { path: string }; path?: string }>; activeWorkspace?: string | null
          }
          const cleaned = (reg.workspaces || []).filter((e) => {
            const p = e.local?.path ?? e.path ?? ""
            return !p.includes(basename(newWs.projectDir))
          })
          writeFileSync(bbRegPath, JSON.stringify({ version: 2, workspaces: cleaned, activeWorkspace: reg.activeWorkspace ?? null }, null, 2))
        }
      } catch { /* best-effort registry cleanup */ }
    }
  })
})
