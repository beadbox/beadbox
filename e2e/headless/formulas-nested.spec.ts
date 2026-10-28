// The Formulas tab on a nested formula (beadbox-ptca.2): one container per
// step, its children inside in dependency order, where it used to draw the
// steps as a single PARALLEL block with no children. bd is the judge of the
// formula: the steps and children compared are the ones `bd formula show`
// returns. The formula is synthetic (the unit test's fixture), written into
// this worker's workspace; formulas are files, so no Dolt write is involved.

import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { NESTED_CHILD_ORDER, nestedFormula } from "../../packages/client/src/__tests__/formula-fixtures"
import { expect, test } from "../fixtures/harness"

const NAME = "e2e-nested-steps"

type Shown = { steps: Array<{ id: string; children?: Array<{ id: string }> }> }

test("a nested formula draws each step as a group holding its children in order", async ({ page, workspace }, testInfo) => {
  const dir = join(workspace.beadsDir, "formulas")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${NAME}.formula.json`),
    JSON.stringify({ formula: NAME, description: "synthetic nested formula", version: 1, type: "workflow", steps: nestedFormula() }),
  )
  const shown = workspace.bdJson<Shown>(["formula", "show", NAME])
  expect(shown.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"])

  await page.goto("/")
  await page.getByRole("button", { name: "Formulas", exact: true }).click()
  // The view selects a formula by itself once the list loads (the first one
  // here, the only formula in this workspace), and clicking the selected
  // formula deselects it. So wait for a selection, and click ours only when
  // another formula is the one selected.
  const formulaButton = page.getByRole("button", { name: new RegExp(`^${NAME}`) })
  const selected = page.getByRole("heading", { name: NAME, exact: true })
  await expect(formulaButton).toBeVisible()
  await expect(page.getByText("Step Graph", { exact: true })).toBeVisible()
  if (!(await selected.isVisible())) await formulaButton.click()
  await expect(selected).toBeVisible()
  await page.getByTitle("Graph view").click()

  const groups = page.getByTestId("formula-step-group")
  await expect(groups).toHaveCount(shown.steps.length)
  await page.screenshot({ path: testInfo.outputPath("nested-formula-after.png"), fullPage: true })

  for (const step of shown.steps) {
    const group = page.locator(`[data-testid="formula-step-group"][data-step-group-id="${step.id}"]`)
    const childIds = await group
      .getByTestId("formula-step-child")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-step-id")))
    // Every child bd lists, in dependency order.
    expect(childIds).toEqual(NESTED_CHILD_ORDER[step.id])
    expect([...childIds].sort()).toEqual((step.children ?? []).map((c) => c.id).sort())
  }
  // The old rendering: one PARALLEL block of the steps.
  await expect(page.getByText("Parallel", { exact: true })).toHaveCount(0)

  // Keyboard as today: a child row is a focusable button.
  const firstChild = page.locator('[data-step-id="s1.a"]')
  await firstChild.focus()
  await expect(firstChild).toBeFocused()
})
