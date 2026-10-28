// Formulas tab, closed/total per step (beadbox-ptca.4), on e2e-molecules: one
// poured nested formula (seeded in global-setup), in its own workspace so no
// other spec sees a molecule. Each step header's count must equal bd's own
// count of that step's children, in the tree and the graph view, and a bd
// close on a child must move it with no click.

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"
import type { HarnessWorkspace } from "../fixtures/harness"
import { NESTED_FORMULA } from "../global-setup"

type Row = { id: string; title: string; status: string }

// Formula step id -> the title bd poured it under (Step 1's {{who}} was bob).
const STEPS: Record<string, string> = { s1: "Step 1: bob prepares", s2: "Step 2: ship", s3: "Step 3: empty" }

function molecule(ws: HarnessWorkspace): { id: string; issues: Row[] } {
  const mols = ws.bdJson<Row[]>(["list", "--type", "molecule", "--status", "all", "--limit", "0", "--flat"])
  const root = mols.find((m) => m.title === NESTED_FORMULA)
  if (!root) throw new Error(`fixture molecule '${NESTED_FORMULA}' missing`)
  return { id: root.id, issues: ws.bdJson<{ issues: Row[] }>(["mol", "show", root.id]).issues }
}

/** bd's count of a step bead's children, as "closed/total". */
function bdCount(ws: HarnessWorkspace, stepTitle: string): string {
  const step = molecule(ws).issues.find((i) => i.title === stepTitle)
  if (!step) throw new Error(`step '${stepTitle}' not poured`)
  const kids = ws.bdJson<Row[]>(["list", "--parent", step.id, "--status", "all", "--limit", "0"])
  return `${kids.filter((k) => k.status === "closed").length}/${kids.length}`
}

const badge = (page: Page, stepId: string) => page.locator(`[data-testid="step-count"][data-step-id="${stepId}"]`)

async function expectCountsMatchBd(page: Page, ws: HarnessWorkspace): Promise<void> {
  for (const [stepId, title] of Object.entries(STEPS)) {
    await expect(badge(page, stepId)).toHaveText(bdCount(ws, title))
  }
}

/** Switch to the molecules workspace, open Formulas, select the poured molecule. */
async function openMolecule(page: Page, ws: HarnessWorkspace): Promise<void> {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText("e2e-standard")
  await page.getByRole("button", { name: `Open ${ws.name}` }).click()
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(ws.name)
  await page.getByRole("button", { name: "Formulas", exact: true }).click()
  // The only formula is selected on load; clicking it would deselect it.
  await expect(page.getByText("Active Molecules (1)")).toBeVisible()
  await expect(page.getByTestId("step-count")).toHaveCount(0)
  await page.locator("button", { has: page.getByText(NESTED_FORMULA, { exact: true }) }).filter({ hasText: /\d+\/\d+/ }).click()
}

test("each step header shows closed/total of its children, as bd counts them", async ({ page, moleculesWorkspace: ws }) => {
  await openMolecule(page, ws)
  await expect(page.getByTestId("step-count")).toHaveCount(3)
  await expectCountsMatchBd(page, ws)
  // The seeded pour: three children, one child, and a step with none. Only the
  // totals are pinned: the next test closes a child in this worker's copy.
  await expect(badge(page, "s1")).toHaveText(/^\d\/3$/)
  await expect(badge(page, "s2")).toHaveText(/^\d\/1$/)
  await expect(badge(page, "s3")).toHaveText("0/0")

  await page.getByTitle("Graph view").click()
  await expect(page.getByTestId("step-count")).toHaveCount(3)
  await expectCountsMatchBd(page, ws)
})

test("a bd close on a child moves its step's count with no click", async ({ page, moleculesWorkspace: ws }) => {
  await openMolecule(page, ws)
  await expect(badge(page, "s1")).toHaveText(bdCount(ws, STEPS.s1!))
  const before = bdCount(ws, STEPS.s1!)

  const child = molecule(ws).issues.find((i) => i.title === "Child 1a" && i.status !== "closed")
  if (!child) throw new Error("fixture child 'Child 1a' missing or already closed")
  ws.bd(["close", child.id])
  const after = bdCount(ws, STEPS.s1!)
  expect(after).not.toBe(before)

  // No click and no reload from here on: only the live-update path can move it.
  await expect(badge(page, "s1")).toHaveText(after, { timeout: 8_000 })
  await expectCountsMatchBd(page, ws)
})
