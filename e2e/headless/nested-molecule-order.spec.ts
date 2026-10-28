// beadbox-e04o.3: a nested molecule's steps in the plan's order, children in
// dependency order, and j/k walking that order. The test pours its own
// molecule from a synthetic formula whose steps have NO edges of their own:
// the only order comes from a child of Step A needing a child of Step B (bd
// 1.3.1 writes that as a blocks edge between the two children only). Pour
// order is A, B, C; the plan's order is B, A, C. Inside Step A, A2 is poured
// before A1 but needs it.
//
// It pours into the gates workspace, which no other spec counts molecules in,
// so the shared e2e-molecules template and its specs are untouched. The
// formula is a file and the pour adds beads only; no gate is created, so the
// Waiting view's specs see nothing new.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"
import type { HarnessWorkspace } from "../fixtures/harness"

type Row = {
  id: string
  title: string
  issue_type: string
  parent?: string
  dependencies?: Array<{ depends_on_id: string; type: string }>
}

const STEPS = { sA: "Step A: build", sB: "Step B: design", sC: "Step C: notes" } as const

function pour(ws: HarnessWorkspace): { name: string; root: string } {
  const name = `cross-flow-${Date.now()}`
  mkdirSync(join(ws.beadsDir, "formulas"), { recursive: true })
  const formula = {
    formula: name,
    version: 1,
    type: "workflow",
    description: "Synthetic nested molecule ordered only by cross-step children",
    steps: [
      {
        id: "sA",
        title: STEPS.sA,
        children: [
          { id: "a2", title: "A2", needs: ["a1"] },
          { id: "a1", title: "A1", needs: ["b1"] },
        ],
      },
      { id: "sB", title: STEPS.sB, children: [{ id: "b1", title: "B1" }] },
      { id: "sC", title: STEPS.sC, children: [{ id: "c1", title: "C1" }] },
    ],
  }
  writeFileSync(join(ws.beadsDir, "formulas", `${name}.formula.json`), JSON.stringify(formula))
  const poured = ws.bdJson<{ new_epic_id: string }>(["mol", "pour", name])
  return { name, root: poured.new_epic_id }
}

const list = (ws: HarnessWorkspace, parent: string) =>
  ws.bdJson<Row[]>(["list", "--parent", parent, "--status", "all", "--limit", "0", "--flat"])
const byTitle = (rows: Row[], title: string) => {
  const row = rows.find((r) => r.title === title)
  if (!row) throw new Error(`poured bead '${title}' missing`)
  return row
}
const blocksOn = (row: Row) =>
  (row.dependencies ?? []).filter((d) => d.type === "blocks").map((d) => d.depends_on_id)

const focusedId = (page: Page) =>
  page.$$eval("[data-item-id]", (els) =>
    els.filter((el) => el.className.includes("ring-primary/60")).map((el) => el.getAttribute("data-item-id")),
  )

async function openGatesWorkspace(page: Page, ws: HarnessWorkspace): Promise<void> {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText("e2e-standard")
  await page.getByRole("button", { name: `Open ${ws.name}` }).click()
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(ws.name)
}

test("steps follow the children's cross-step needs, children their in-step needs, and j/k walks it", async ({
  page,
  gatesWorkspace: ws,
}) => {
  const { name, root } = pour(ws)
  const steps = list(ws, root)
  expect(steps.map((s) => s.issue_type)).toEqual(["epic", "epic", "epic"])
  const [sA, sB, sC] = [byTitle(steps, STEPS.sA), byTitle(steps, STEPS.sB), byTitle(steps, STEPS.sC)]
  const aRows = list(ws, sA.id)
  const [a1, a2, b1] = [byTitle(aRows, "A1"), byTitle(aRows, "A2"), byTitle(list(ws, sB.id), "B1")]
  const c1 = byTitle(list(ws, sC.id), "C1")

  // bd is the judge of the edges: no step has a blocks edge of its own, A1
  // needs B1 (cross-step), A2 needs A1 (in-step).
  for (const s of [sA, sB, sC]) expect(blocksOn(s)).toEqual([])
  expect(blocksOn(a1)).toEqual([b1.id])
  expect(blocksOn(a2)).toEqual([a1.id])

  await openGatesWorkspace(page, ws)
  // Keyboard to the root, open it: the headers come in the plan's order.
  await expect(page.locator(`[data-item-id="${root}"]`).first()).toBeVisible()
  for (let i = 0; i < 80 && (await focusedId(page))[0] !== root; i++) await page.keyboard.press("j")
  await expect.poll(() => focusedId(page)).toEqual([root])
  await page.keyboard.press("l")
  await expect(page.locator("[data-step-header]").first()).toBeVisible()
  const headers = await page.$$eval(`[data-item-id="${root}"] [data-step-header]`, (els) =>
    els.map((el) => el.getAttribute("data-item-id")),
  )
  // The plan decides only that B comes before A. C has no edge either way, so
  // it keeps its place in the tree's own order (bd's list order, which is not
  // the formula's); it is not pinned here.
  expect([...headers].sort()).toEqual([sA.id, sB.id, sC.id].sort())
  expect(headers.indexOf(sB.id)).toBeLessThan(headers.indexOf(sA.id))

  // j/k: each header in drawn order, l to open it, its rows in drawn order,
  // then the next header. Inside Step A, A1 comes before A2 (A2 needs A1).
  const press = async (key: string, expected: string) => {
    await page.keyboard.press(key)
    await expect.poll(() => focusedId(page)).toEqual([expected])
  }
  const rowsOf: Record<string, string[]> = {
    [sB.id]: [b1.id],
    [sA.id]: [a1.id, a2.id],
    [sC.id]: [c1.id],
  }
  const walked: string[] = []
  for (const h of headers as string[]) {
    await press("j", h)
    walked.push(h)
    await page.keyboard.press("l")
    const drawn = (
      await page.$$eval(`[data-step-section="${h}"] [data-item-id]`, (els) =>
        els.map((el) => el.getAttribute("data-item-id")),
      )
    ).filter((id) => id !== h)
    expect(drawn).toEqual(rowsOf[h]!)
    for (const row of drawn) {
      await press("j", row!)
      walked.push(row!)
    }
  }
  // And back: k retraces the same order.
  await press("k", walked[walked.length - 2]!)
  await press("k", walked[walked.length - 3]!)
  // Every step open: the root's card, for the bead.
  await page
    .locator(`[data-item-id="${root}"]`)
    .first()
    .screenshot({ path: test.info().outputPath("nested-molecule-order.png") })

  // The Formulas tab agrees: every edge it draws between steps runs from a
  // step the tree lists earlier to one it lists later.
  await page.getByRole("button", { name: "Formulas", exact: true }).click()
  const formulaButton = page.getByRole("button", { name: new RegExp(`^${name}`) })
  await expect(formulaButton).toBeVisible()
  await expect(page.getByText("Step Graph", { exact: true })).toBeVisible()
  if (!(await page.getByRole("heading", { name, exact: true }).isVisible())) await formulaButton.click()
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
  await page.getByTitle("Graph view").click()
  await expect(page.getByTestId("formula-step-group")).toHaveCount(3)
  const stepPairs = () =>
    page.$$eval('[data-testid^="rf__edge-"]', (els) =>
      els
        .map((e) => (e.getAttribute("data-testid") ?? "").replace("rf__edge-", ""))
        .filter((id) => !id.includes("__start__") && !id.includes("__end__")),
    )
  await expect.poll(stepPairs).toEqual(["sB->sA"])
  const formulaId: Record<string, string> = { [sA.id]: "sA", [sB.id]: "sB", [sC.id]: "sC" }
  const treeOrder = (headers as string[]).map((h) => formulaId[h])
  for (const pair of await stepPairs()) {
    const [from, to] = pair.split("->") as [string, string]
    expect(treeOrder.indexOf(from)).toBeLessThan(treeOrder.indexOf(to))
  }
})
