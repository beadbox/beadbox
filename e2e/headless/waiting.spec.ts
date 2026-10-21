// The Waiting view (beadbox-37h5; GitHub #60, PR #61; spec section 4.11) on
// its own synthetic workspace, e2e-gates (seeded in global-setup): a human, a
// timer and a gh:run gate, and a human gate on an epic past the per-gate cap.
// bd is the judge throughout: the rows are compared with `bd gate list`, and a
// resolve is checked with `bd show`.
//
// The gates workspace is per worker and shared by the tests that worker runs,
// so a test that resolves a gate first creates its own; the seeded gates stay
// open.

import type { Locator, Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"
import type { HarnessWorkspace } from "../fixtures/harness"
import { BIG_EPIC_CHILDREN } from "../global-setup"

type Gate = { id: string; title: string; status: string; created_at: string; await_type?: string }
type Shown = { id: string; status: string; close_reason?: string }

const waitingTab = (page: Page) => page.getByRole("button", { name: "Waiting", exact: true })
const cards = (page: Page) => page.getByTestId("waiting-gate")
// By text, not role: while the Resolve prompt is open the page behind it is
// aria-hidden, and a role lookup would find no card at all (a false "gone").
const cardFor = (page: Page, gateId: string) =>
  cards(page).filter({ has: page.locator("button.font-mono").getByText(gateId, { exact: true }) })

function openGates(ws: HarnessWorkspace): Gate[] {
  return ws.bdJson<Gate[] | null>(["gate", "list"]) ?? []
}

function show(ws: HarnessWorkspace, id: string): Shown {
  const shown = ws.bdJson<Shown[] | Shown>(["show", id])
  return Array.isArray(shown) ? (shown[0] as Shown) : shown
}

function taskId(ws: HarnessWorkspace, title: string): string {
  const all = ws.bdJson<Array<{ id: string; title: string }>>(["list", "--status", "all", "--limit", "0", "--flat"])
  const task = all.find((b) => b.title === title)
  if (!task) throw new Error(`fixture bead '${title}' missing`)
  return task.id
}

function createHumanGate(ws: HarnessWorkspace, blocks: string): string {
  return ws.bdJson<{ id: string }>(["gate", "create", "--type=human", `--blocks=${blocks}`]).id
}

/** Start on the standard workspace (no gate, so no tab), switch from the rail, open the tab. */
async function openWaiting(page: Page, ws: HarnessWorkspace): Promise<void> {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText("e2e-standard")
  await expect(page.locator("[data-item-id]").first()).toBeVisible()
  await expect(waitingTab(page)).toHaveCount(0)
  await page.getByRole("button", { name: `Open ${ws.name}` }).click()
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(ws.name)
  await waitingTab(page).click()
  await expect(page.getByRole("heading", { name: "Waiting" })).toBeVisible()
  await expect(cards(page).first()).toBeVisible()
}

/** The gate ids in the order the view renders them (each card's first id button is its gate's). */
function renderedGateIds(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid="waiting-gate"]', (els) =>
    els.map((card) => card.querySelector("button.font-mono")?.textContent ?? ""),
  )
}

/** Press Tab until `target` has focus, at most `max` times: the keyboard path, not a click. */
async function tabTo(page: Page, target: Locator, max = 8): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press("Tab")
  }
  await expect(target).toBeFocused()
}

test("the view lists exactly the gates bd lists, oldest first, Resolve on human gates only", async ({
  page,
  gatesWorkspace: ws,
}) => {
  await openWaiting(page, ws)
  const gates = openGates(ws)
  expect(gates.length).toBeGreaterThanOrEqual(4)
  const oldestFirst = [...gates]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id))
    .map((g) => g.id)
  await expect.poll(() => renderedGateIds(page)).toEqual(oldestFirst)

  for (const gate of gates) {
    const card = cardFor(page, gate.id)
    await expect(card).toContainText(`${gate.await_type} gate`)
    await expect(card.getByRole("button", { name: "Resolve" })).toHaveCount(gate.await_type === "human" ? 1 : 0)
  }
  const byType = (type: string) => gates.find((g) => g.await_type === type)?.id ?? `no ${type} gate`
  await expect(cardFor(page, byType("gh:run"))).toContainText("awaits 123456789")
  await expect(cardFor(page, byType("timer"))).toContainText("expires in")
})

test("a gate bd creates appears live; Resolve closes it in bd with the reason and releases its task", async ({
  page,
  gatesWorkspace: ws,
}) => {
  await openWaiting(page, ws)
  const task = taskId(ws, "Spare task 1")
  const gateId = createHumanGate(ws, task)
  // No click and no reload: only the live-update path can put it on screen.
  await expect(cardFor(page, gateId)).toBeVisible({ timeout: 8_000 })

  await cardFor(page, gateId).getByRole("button", { name: "Resolve" }).click()
  const dialog = page.getByRole("alertdialog")
  await dialog.getByLabel("Reason (optional)").fill("approved in e2e")
  await dialog.getByRole("button", { name: "Resolve" }).click()

  await expect(page.getByText(`Gate ${gateId} resolved`)).toBeVisible()
  await expect(cardFor(page, gateId)).toHaveCount(0)
  expect(show(ws, gateId)).toMatchObject({ status: "closed", close_reason: "approved in e2e" })
  const ready = ws.bdJson<Array<{ id: string }>>(["ready", "--limit", "0"]).map((b) => b.id)
  expect(ready).toContain(task)
})

test("a gate past the per-gate cap lists 200, says so, and prompts '(at least 200 open)'", async ({
  page,
  gatesWorkspace: ws,
}) => {
  expect(BIG_EPIC_CHILDREN).toBeGreaterThan(200)
  await openWaiting(page, ws)
  const big = openGates(ws).find((g) => g.title === "Gate: big epic sign-off")
  if (!big) throw new Error("fixture gate 'Gate: big epic sign-off' missing")
  const card = cardFor(page, big.id)

  await expect(card.locator("ul > li")).toHaveCount(200)
  await expect(card.getByTestId("held-capped")).toHaveText(
    `Showing the first 200 beads this gate holds. For all of them: bd dep list ${big.id}`,
  )
  await expect(card.getByTestId("held-capped").locator("code")).toHaveText(`bd dep list ${big.id}`)

  await card.getByRole("button", { name: "Resolve" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText("Anything it holds (at least 200 open) is released")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toHaveCount(0)
  expect(show(ws, big.id).status).toBe("open")
})

test("keyboard: Tab reaches Resolve then the held bead, Escape writes nothing, Enter resolves", async ({
  page,
  gatesWorkspace: ws,
}) => {
  await openWaiting(page, ws)
  const task = taskId(ws, "Spare task 2")
  const gateId = createHumanGate(ws, task)
  const card = cardFor(page, gateId)
  await expect(card).toBeVisible({ timeout: 8_000 })
  const resolve = card.getByRole("button", { name: "Resolve" })
  const held = card.getByRole("button", { name: task, exact: true })

  // Reading order: the gate's id, then its Resolve, then the beads it holds.
  await card.getByRole("button", { name: gateId, exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(resolve).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(held).toBeFocused()

  // Enter on Resolve opens the prompt; Escape closes it with no write.
  await page.keyboard.press("Shift+Tab")
  await expect(resolve).toBeFocused()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  expect(show(ws, gateId).status).toBe("open")

  // Enter on a held bead opens it in the Beads view's detail panel.
  await held.focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole("button", { name: "Add label" })).toBeVisible()
  await expect(page.getByText("Spare task 2", { exact: true }).last()).toBeVisible()

  // Back with the view shortcut, then resolve with the keyboard only.
  await page.keyboard.press("Control+6")
  await expect(page.getByRole("heading", { name: "Waiting" })).toBeVisible()
  await resolve.focus()
  await page.keyboard.press("Enter")
  await expect(dialog).toBeVisible()
  await tabTo(page, dialog.getByLabel("Reason (optional)"))
  await page.keyboard.type("keyboard resolve")
  await tabTo(page, dialog.getByRole("button", { name: "Resolve" }))
  await page.keyboard.press("Enter")

  await expect(page.getByText(`Gate ${gateId} resolved`)).toBeVisible()
  await expect(card).toHaveCount(0)
  expect(show(ws, gateId)).toMatchObject({ status: "closed", close_reason: "keyboard resolve" })
})
