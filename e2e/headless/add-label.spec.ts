// Check A (beadbox-r72.4, behaviour from beadbox-m4i / GH #57): a label added
// from the detail panel shows as a chip AND is written to bd.

import { expect, test } from "../fixtures/harness"
import { bdLabels, labelChips, openDetail, openTree } from "./helpers"

test("a label added from the detail panel shows as a chip and bd lists it", async ({ page, workspace }) => {
  const beads = await openTree(page, workspace)
  const bead = beads.find((b) => b.title === "High Priority Task")
  if (!bead) throw new Error("fixture bead 'High Priority Task' missing")
  expect(bdLabels(workspace, bead.id)).not.toContain("e2e-ui")

  await openDetail(page, bead)
  await page.getByRole("button", { name: "Add label" }).click()
  await page.getByRole("combobox", { name: "New label" }).fill("e2e-ui")
  await page.keyboard.press("Enter")

  await expect(labelChips(page).getByText("e2e-ui", { exact: true })).toBeVisible()
  await expect.poll(() => bdLabels(workspace, bead.id)).toContain("e2e-ui")
})
