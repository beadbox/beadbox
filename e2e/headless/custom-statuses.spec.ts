// Check C (beadbox-r72.4, behaviour from beadbox-429 / GH #56): bd 1.3 custom
// statuses in name:category form. At default filters ("All Status" means no
// narrowing) every bead is listed; the Status filter names the statuses with
// no :category suffix; unchecking one narrows, to exactly what bd returns for
// the remaining statuses.

import { expect, test } from "../fixtures/harness"
import { CUSTOM_STATUSES } from "../global-setup"
import { type Listed, renderedIds } from "./helpers"

const NAMES = CUSTOM_STATUSES.split(",").map((s) => s.split(":")[0])
const LABELS: Record<string, string> = {
  ticket_awaiting: "Ticket Awaiting",
  ticket_active: "Ticket Active",
  unit_escalated: "Unit Escalated",
}

test("name:category custom statuses: every bead listed, names without suffix, unchecking narrows", async ({
  page,
  statusesWorkspace: ws,
}) => {
  expect(ws.bd(["config", "get", "status.custom"]).trim()).toBe(CUSTOM_STATUSES)
  const all = ws.bdJson<Listed[]>(["list", "--status", "all", "--limit", "0", "--flat"])
  expect(all.map((b) => b.status).sort()).toEqual([...NAMES].sort())

  // Start on the standard workspace (the registry's active one), and switch
  // from the rail once that tree is up, as a user would.
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText("e2e-standard")
  await expect(page.locator("[data-item-id]").first()).toBeVisible()
  await page.getByRole("button", { name: `Open ${ws.name}` }).click()
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(ws.name)

  // 1. At default filters every bead is listed (All Status does not narrow).
  await expect.poll(() => renderedIds(page)).toEqual(all.map((b) => b.id).sort())

  // 2. The Status filter lists each status by name, with no :category suffix.
  await page.getByRole("button", { name: "Status filter" }).click()
  for (const name of NAMES) {
    await expect(page.getByRole("checkbox", { name: LABELS[name], exact: true })).toBeVisible()
  }
  await expect(page.locator("[data-multi-select-row]").filter({ hasText: /:(active|wip|frozen)\b/ })).toHaveCount(0)

  // 3. Unchecking one narrows to exactly what bd returns for the others.
  await page.locator("[data-multi-select-row]").filter({ hasText: LABELS.unit_escalated }).click()
  await page.keyboard.press("Escape")
  const narrowed = ws.bdJson<Listed[]>(["list", "--status", "ticket_awaiting,ticket_active", "--limit", "0", "--flat"])
  expect(narrowed.length).toBe(2)
  await expect.poll(() => renderedIds(page)).toEqual(narrowed.map((b) => b.id).sort())
})
