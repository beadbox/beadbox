// Check B (beadbox-r72.4, behaviour from beadbox-o9a): a label written by bd,
// outside the app, appears in the open detail panel within 8 s, with no click
// and no reload. This is the live-update path end to end: bd -> Dolt -> the
// sidecar's change detector -> a [SUBSCRIPTION] line -> the page's refetch.

import { expect, test } from "../fixtures/harness"
import { bdLabels, labelChips, openDetail, openTree } from "./helpers"

test("a label bd writes appears in the open detail panel within 8 s", async ({ page, workspace }) => {
  const beads = await openTree(page, workspace)
  const bead = beads.find((b) => b.title === "Critical Bug")
  if (!bead) throw new Error("fixture bead 'Critical Bug' missing")
  await openDetail(page, bead)
  await expect(labelChips(page).getByText("e2e-cli", { exact: true })).toHaveCount(0)

  workspace.bd(["update", bead.id, "--add-label", "e2e-cli"])
  expect(bdLabels(workspace, bead.id)).toContain("e2e-cli")

  // No click and no reload from here on: only the live-update path can put it on screen.
  await expect(labelChips(page).getByText("e2e-cli", { exact: true })).toBeVisible({ timeout: 8_000 })
})
