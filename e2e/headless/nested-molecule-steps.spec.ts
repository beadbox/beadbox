// beadbox-e04o.1: in the Beads view a nested molecule shows one header per step
// with the step's children under it, and the keys reach everything they reach
// on a step today. On e2e-molecules (seeded in global-setup): nest-flow poured
// once, s1 with three children and s2 with one (epics under the root), and s3,
// which has no children, so bd pours it as a task: a loose row of the root,
// whose phases come before the step headers.

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"
import type { HarnessWorkspace } from "../fixtures/harness"
import { NESTED_FORMULA } from "../global-setup"

type Row = { id: string; title: string; issue_type: string; status: string }

function rootId(ws: HarnessWorkspace): string {
  const mols = ws.bdJson<Row[]>(["list", "--type", "molecule", "--status", "all", "--limit", "0", "--flat"])
  const root = mols.find((m) => m.title === NESTED_FORMULA)
  if (!root) throw new Error(`fixture molecule '${NESTED_FORMULA}' missing`)
  return root.id
}

const childrenOf = (ws: HarnessWorkspace, id: string) =>
  ws.bdJson<Row[]>(["list", "--parent", id, "--status", "all", "--limit", "0", "--flat"])

const header = (page: Page, stepId: string) => page.locator(`[data-step-header][data-item-id="${stepId}"]`)

/** The item the tree's keyboard focus is on: the one carrying the focus ring. */
const focusedId = (page: Page) =>
  page.$$eval("[data-item-id]", (els) =>
    els.filter((el) => el.className.includes("ring-primary/60")).map((el) => el.getAttribute("data-item-id")),
  )

async function openMolecules(page: Page, ws: HarnessWorkspace): Promise<void> {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText("e2e-standard")
  await page.getByRole("button", { name: `Open ${ws.name}` }).click()
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(ws.name)
}

test("a nested molecule shows a header per step with its children, and no step is a molecule", async ({
  page,
  moleculesWorkspace: ws,
}) => {
  const root = rootId(ws)
  const under = childrenOf(ws, root)
  const steps = under.filter((b) => b.issue_type === "epic")
  const loose = under.filter((b) => b.issue_type !== "epic")
  expect(steps.map((s) => s.title).sort()).toEqual(["Step 1: bob prepares", "Step 2: ship"])

  await openMolecules(page, ws)
  const rootRow = page.locator(`[data-item-id="${root}"]`).first()
  await rootRow.locator("button").first().click()

  // One header per step, reading its title, and no molecule icon on a step.
  for (const step of steps) {
    await expect(header(page, step.id)).toBeVisible()
    await expect(header(page, step.id)).toContainText(step.title)
  }
  await expect(page.locator("[data-step-header]")).toHaveCount(steps.length)
  // Inside the root's card only the root itself carries the molecule hexagon
  // (the MOLECULES section header has one of its own, outside the card).
  await expect(rootRow.locator("svg.lucide-hexagon")).toHaveCount(1)

  // The loose task (s3) sits in the root's phases, before the first header.
  for (const b of loose) await expect(page.locator(`[data-item-id="${b.id}"]`)).toBeVisible()
  const order = await page.$$eval("[data-item-id]", (els) => els.map((el) => el.getAttribute("data-item-id")))
  const firstHeader = Math.min(...steps.map((s) => order.indexOf(s.id)))
  for (const b of loose) expect(order.indexOf(b.id)).toBeLessThan(firstHeader)

  // An unfinished step starts open (beadbox-e04o.2): each header lists exactly
  // bd's children of that step, and they are not phased from "Phase 1" on
  // their own.
  for (const step of steps) {
    await expect(header(page, step.id)).toHaveAttribute("aria-expanded", "true")
    for (const c of childrenOf(ws, step.id)) await expect(page.locator(`[data-item-id="${c.id}"]`)).toBeVisible()
  }
  await expect(page.getByText(/^Phase \d+$/)).toHaveCount(1) // the loose task's phase only
})

test("j/k walk the root, its loose row, each header and its rows; h/l collapse and expand a step", async ({
  page,
  moleculesWorkspace: ws,
}) => {
  const root = rootId(ws)
  const under = childrenOf(ws, root)
  const s3 = under.find((b) => b.issue_type !== "epic")!
  const domOrder = async () => page.$$eval("[data-item-id]", (els) => els.map((el) => el.getAttribute("data-item-id")))

  await openMolecules(page, ws)
  await expect(page.locator(`[data-item-id="${root}"]`).first()).toBeVisible()
  const press = async (key: string, expected: string) => {
    await page.keyboard.press(key)
    await expect.poll(() => focusedId(page)).toEqual([expected])
  }

  // j down to the root (another spec in this worker may have added items above it).
  for (let i = 0; i < 20 && (await focusedId(page))[0] !== root; i++) await page.keyboard.press("j")
  await expect.poll(() => focusedId(page)).toEqual([root])
  await page.keyboard.press("l") // expand the root
  await expect(page.locator("[data-step-header]").first()).toBeVisible()
  await press("j", s3!.id) // loose row first
  // The headers in the order the tree draws them (the tree's own child order).
  const headers = await page.$$eval("[data-step-header]", (els) => els.map((el) => el.getAttribute("data-item-id")!))
  expect(headers).toHaveLength(2)
  const [first, second] = headers as [string, string]
  const firstRows = childrenOf(ws, first)
  const secondRows = childrenOf(ws, second)
  await press("j", first) // then the first header, focusable with the step's id
  await expect(page.locator(`[data-item-id="${firstRows[0]!.id}"]`)).toBeVisible() // open: unfinished
  await page.keyboard.press("h") // h collapses it
  await expect(page.locator(`[data-item-id="${firstRows[0]!.id}"]`)).toHaveCount(0)
  await page.keyboard.press("l") // l expands it
  await expect(page.locator(`[data-item-id="${firstRows[0]!.id}"]`)).toBeVisible()

  // j enters the header's rows in the order they are drawn, then the next header.
  const drawn = (await domOrder()).filter((id) => firstRows.some((r) => r.id === id))
  expect(drawn).toHaveLength(firstRows.length)
  for (const id of drawn) await press("j", id!)
  await press("j", second)

  // k back to the first header; h collapses it, and j then skips its rows.
  for (const id of [...drawn].reverse()) await press("k", id!)
  await press("k", first)
  await page.keyboard.press("h")
  await expect(page.locator(`[data-item-id="${firstRows[0]!.id}"]`)).toHaveCount(0)
  await press("j", second)

  // The second header is open (unfinished): j into its first row, Enter opens
  // the detail panel.
  const secondDrawn = (await domOrder()).filter((id) => secondRows.some((r) => r.id === id))
  await press("j", secondDrawn[0]!)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Add label" })).toBeVisible()
})

const countOf = (ws: HarnessWorkspace, stepId: string) => {
  const kids = childrenOf(ws, stepId)
  return `${kids.filter((k) => k.status === "closed").length}/${kids.length}`
}

test("each header shows closed/total as bd counts it; a finished step collapses and l reopens it; one molecule counted", async ({
  page,
  moleculesWorkspace: ws,
}) => {
  const root = rootId(ws)
  const steps = childrenOf(ws, root).filter((b) => b.issue_type === "epic")
  await openMolecules(page, ws)

  // The MOLECULES section counts roots only: bd's molecules, not their steps.
  const molecules = ws.bdJson<Row[]>(["list", "--type", "molecule", "--status", "all", "--limit", "0", "--flat"])
  const section = page.locator("button", { has: page.getByText("Molecules", { exact: true }) })
  await expect(section).toContainText(`(${molecules.length})`)

  await page.locator(`[data-item-id="${root}"]`).first().locator("button").first().click()
  for (const step of steps) {
    await expect(header(page, step.id).locator("[data-step-count]")).toHaveText(countOf(ws, step.id))
  }

  // Close every open child of the one-child step: its count fills and it collapses.
  const small = steps.find((s) => childrenOf(ws, s.id).length === 1)!
  for (const c of childrenOf(ws, small.id).filter((k) => k.status !== "closed")) ws.bd(["close", c.id])
  const kid = childrenOf(ws, small.id)[0]!
  await expect(header(page, small.id).locator("[data-step-count]")).toHaveText(countOf(ws, small.id), { timeout: 8_000 })
  await expect(header(page, small.id)).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator(`[data-item-id="${kid.id}"]`)).toHaveCount(0)

  // The keyboard still reaches the collapsed header, and l opens it.
  for (let i = 0; i < 20; i++) {
    if ((await focusedId(page))[0] === small.id) break
    await page.keyboard.press("j")
  }
  await expect.poll(() => focusedId(page)).toEqual([small.id])
  await page.keyboard.press("l")
  await expect(page.locator(`[data-item-id="${kid.id}"]`)).toBeVisible()
})
