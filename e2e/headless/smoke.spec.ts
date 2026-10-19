// The headless harness, end to end (beadbox-r72.3): a test build of the real
// bundle, the real sidecar through the test transport, real bd + Dolt data.
//
// The startup gate renders no routed view until the sidecar's health check
// passes, so a tree on screen proves the whole path: page -> binding ->
// sidecar -> bd -> Dolt and back. The tree must then show exactly the beads bd
// has. The default view is "All Status", which shows closed beads too, so the
// comparison is with `bd list --status all` (the query the app itself runs);
// plain `bd list` hides closed beads.

import { expect, test } from "../fixtures/harness"

type Listed = { id: string; issue_type: string }

test("the startup gate passes and the epic tree shows every bead bd lists", async ({ page, workspace }) => {
  const beads = workspace.bdJson<Listed[]>(["list", "--status", "all", "--limit", "0", "--flat"])
  expect(beads.length).toBeGreaterThan(0)

  await page.goto("/")

  // Epics start collapsed; open each one with its chevron (the row's first button).
  for (const epic of beads.filter((b) => b.issue_type === "epic")) {
    const row = page.locator(`[data-item-id="${epic.id}"]`)
    await expect(row).toBeVisible()
    await row.locator("button").first().click()
  }

  const rendered = () =>
    page.$$eval("[data-item-id]", (els) =>
      els.map((e) => e.getAttribute("data-item-id")).filter((id) => id && id !== "_standalone"),
    )
  await expect.poll(async () => (await rendered()).sort()).toEqual(beads.map((b) => b.id).sort())
})
