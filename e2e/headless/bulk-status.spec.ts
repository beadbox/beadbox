// beadbox-id1 (GH #59): bulk status change from the selection toolbar. Rows
// are selected in the tree, a status is picked from the toolbar's Status
// menu, and bd (not the page) is the judge of what was written.
//
// Each test puts the worker's beads back the way it found them: the
// workspaces are per worker and shared by every spec that worker runs, and
// check C (custom-statuses.spec.ts) needs one bead in each custom status.

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"
import type { HarnessWorkspace } from "../fixtures/harness"
import { type Listed, openTree, renderedIds } from "./helpers"

function byTitle(beads: Listed[], title: string): Listed {
  const bead = beads.find((b) => b.title === title)
  if (!bead) throw new Error(`fixture bead '${title}' missing`)
  return bead
}

function bdStatus(ws: HarnessWorkspace, id: string): string {
  const shown = ws.bdJson<Listed[] | Listed>(["show", id])
  return (Array.isArray(shown) ? shown[0] : shown).status
}

/** Run body, then set every bead in `beads` back to the status it had. */
async function restoring(ws: HarnessWorkspace, beads: Listed[], body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } finally {
    for (const b of beads) {
      if (bdStatus(ws, b.id) !== b.status) ws.bd(["update", b.id, "--status", b.status])
    }
  }
}

async function select(page: Page, beads: Listed[]): Promise<void> {
  for (const b of beads) await page.getByRole("checkbox", { name: `Select bead ${b.id}` }).click()
  await expect(page.getByRole("toolbar", { name: "Bulk actions" })).toContainText(`${beads.length} selected`)
}

const statusTrigger = (page: Page) => page.getByRole("button", { name: "Set status of selected" })

async function pick(page: Page, label: string): Promise<void> {
  await statusTrigger(page).click()
  await page.getByRole("menuitem", { name: label, exact: true }).click()
}

test("two beads, an epic child and a loose bead, move to In Progress", async ({ page, workspace: ws }) => {
  const beads = await openTree(page, ws)
  const chosen = [byTitle(beads, "High Priority Task"), byTitle(beads, "Search Target Alpha")]
  await restoring(ws, chosen, async () => {
    await select(page, chosen)
    await pick(page, "In Progress")

    await expect(page.getByText("Updated 2 beads to In Progress")).toBeVisible()
    await expect(page.getByRole("toolbar", { name: "Bulk actions" })).toHaveCount(0)
    for (const b of chosen) {
      expect(bdStatus(ws, b.id)).toBe("in_progress")
      await expect(page.locator(`[data-item-id="${b.id}"] .bead-row-status`)).toHaveText("In Progress")
    }
  })
})

test("Closed closes three beads, one of them already closed", async ({ page, workspace: ws }) => {
  const beads = await openTree(page, ws)
  const chosen = ["High Priority Task", "Critical Bug", "Completed Task"].map((t) => byTitle(beads, t))
  expect(chosen.map((b) => b.status)).toEqual(["open", "open", "closed"])
  await restoring(ws, chosen, async () => {
    await select(page, chosen)
    await pick(page, "Closed")

    await expect(page.getByText("Updated 3 beads to Closed")).toBeVisible()
    const closed = ws.bdJson<Listed[]>(["list", "--status", "closed", "--limit", "0", "--flat"]).map((b) => b.id)
    for (const b of chosen) expect(closed).toContain(b.id)
  })
})

test("custom name:category statuses: listed by name, applied to all three", async ({
  page,
  statusesWorkspace: ws,
}) => {
  const all = ws.bdJson<Listed[]>(["list", "--status", "all", "--limit", "0", "--flat"])
  expect(all).toHaveLength(3)
  await page.goto("/")
  await expect(page.locator("[data-item-id]").first()).toBeVisible()
  await page.getByRole("button", { name: `Open ${ws.name}` }).click()
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(ws.name)
  await expect.poll(() => renderedIds(page)).toEqual(all.map((b) => b.id).sort())

  await restoring(ws, all, async () => {
    await select(page, all)
    await statusTrigger(page).click()
    const items = page.getByRole("menuitem")
    for (const label of ["Ticket Awaiting", "Ticket Active", "Unit Escalated"]) {
      await expect(items.filter({ hasText: label })).toHaveCount(1)
    }
    await expect(items.filter({ hasText: /:(active|wip|frozen)\b/ })).toHaveCount(0)
    await page.getByRole("menuitem", { name: "Unit Escalated", exact: true }).click()

    await expect(page.getByText("Updated 3 beads to Unit Escalated")).toBeVisible()
    const escalated = ws.bdJson<Listed[]>(["list", "--status", "unit_escalated", "--limit", "0", "--flat"])
    expect(escalated.map((b) => b.id).sort()).toEqual(all.map((b) => b.id).sort())
  })
})

test("keyboard only: Escape writes nothing; Enter, arrow, Enter writes", async ({ page, workspace: ws }) => {
  const beads = await openTree(page, ws)
  const bead = byTitle(beads, "Critical Bug")
  expect(bead.status).toBe("open")
  await restoring(ws, [bead], async () => {
    await select(page, [bead])
    await statusTrigger(page).focus()

    await page.keyboard.press("Enter")
    await expect(page.getByRole("menuitem", { name: "Open", exact: true })).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu")).toHaveCount(0)
    expect(bdStatus(ws, bead.id)).toBe("open")
    await expect(page.getByRole("toolbar", { name: "Bulk actions" })).toContainText("1 selected")

    await expect(statusTrigger(page)).toBeFocused()
    await page.keyboard.press("Space")
    await expect(page.getByRole("menuitem", { name: "Open", exact: true })).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(page.getByRole("menuitem", { name: "In Progress", exact: true })).toBeFocused()
    await page.keyboard.press("Enter")
    await expect.poll(() => bdStatus(ws, bead.id)).toBe("in_progress")
  })
})

test("with Status narrowed to Open, moved beads drop out of the view", async ({ page, workspace: ws }) => {
  const beads = await openTree(page, ws)
  const chosen = [byTitle(beads, "Critical Bug"), byTitle(beads, "Search Target Alpha")]
  await restoring(ws, chosen, async () => {
    await page.getByRole("button", { name: "Status filter" }).click()
    await page.locator("[data-multi-select-row]").filter({ hasText: "All Status" }).click()
    await page.locator("[data-multi-select-row]").filter({ hasText: /^Open$/ }).click()
    await page.keyboard.press("Escape")
    await expect.poll(() => renderedIds(page)).toEqual(expect.arrayContaining(chosen.map((b) => b.id)))

    await select(page, chosen)
    await pick(page, "In Progress")

    await expect(page.getByText("Updated 2 beads to In Progress")).toBeVisible()
    await expect.poll(async () => (await renderedIds(page)).filter((id) => chosen.some((b) => b.id === id))).toEqual([])
    for (const b of chosen) expect(bdStatus(ws, b.id)).toBe("in_progress")
  })
})
