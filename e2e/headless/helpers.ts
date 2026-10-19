// Shared steps for headless specs (beadbox-r72.4).

import type { Page } from "@playwright/test"
import { expect } from "../fixtures/harness"
import type { HarnessWorkspace } from "../fixtures/harness"

export type Listed = { id: string; title: string; issue_type: string; status: string; labels?: string[] }

/** Open the app on the active workspace and expand every epic (epics start collapsed). */
export async function openTree(page: Page, workspace: HarnessWorkspace): Promise<Listed[]> {
  const beads = workspace.bdJson<Listed[]>(["list", "--status", "all", "--limit", "0", "--flat"])
  await page.goto("/")
  for (const epic of beads.filter((b) => b.issue_type === "epic")) {
    const row = page.locator(`[data-item-id="${epic.id}"]`)
    await expect(row).toBeVisible()
    await row.locator("button").first().click()
  }
  return beads
}

/** Open a bead's detail panel by clicking its title in the tree. */
export async function openDetail(page: Page, bead: Listed): Promise<void> {
  await page.locator(`[data-item-id="${bead.id}"]`).getByText(bead.title, { exact: true }).click()
  await expect(page.getByRole("button", { name: "Add label" })).toBeVisible()
}

/** The detail panel's label chips: the container the "Add label" button sits in. */
export function labelChips(page: Page) {
  return page.getByRole("button", { name: "Add label" }).locator("xpath=..")
}

/** bd's own record of a bead's labels. */
export function bdLabels(workspace: HarnessWorkspace, id: string): string[] {
  const shown = workspace.bdJson<Listed[] | Listed>(["show", id])
  return (Array.isArray(shown) ? shown[0] : shown).labels ?? []
}

/** The bead ids the tree renders (without the loose-beads group header). */
export function renderedIds(page: Page): Promise<string[]> {
  return page.$$eval("[data-item-id]", (els) =>
    els.map((e) => e.getAttribute("data-item-id") ?? "").filter((id) => id && id !== "_standalone").sort(),
  )
}
