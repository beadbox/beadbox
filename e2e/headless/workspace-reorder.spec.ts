// beadbox-984: the user reorders the Workspaces sidebar by drag and by
// keyboard, the order shows at once, survives a sidecar restart (a relaunch:
// new sidecar process, new page), is saved in Beadbox's registry, and nothing
// under bd changes.

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"

// The registry belongs to the whole worker: put its bytes back after the test,
// pass or fail, so later specs see the original order.
let restoreRegistry: (() => void) | undefined
test.afterEach(() => {
  restoreRegistry?.()
  restoreRegistry = undefined
})

const railOrder = (page: Page) =>
  page.$$eval('[data-testid="workspace-rail-item"]', (els) =>
    els.map((el) => (el as HTMLElement).dataset.workspaceId ?? ""),
  )

const registryOrder = (path: string): string[] =>
  JSON.parse(readFileSync(path, "utf8")).workspaces.map((w: { id: string }) => w.id)

test("drag and keyboard reorder the sidebar; the order survives a restart and bd is untouched", async ({
  page,
  sidecar,
  workspace,
  workspaces,
}) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(15_000)
  const registryPath = workspace.registryPath
  const original = readFileSync(registryPath, "utf8")
  restoreRegistry = () => writeFileSync(registryPath, original)

  const all = [workspaces.standard, workspaces.statuses, workspaces.gates, workspaces.molecules]
  const [w1, w2, w3, w4] = registryOrder(registryPath)
  expect([w1, w2, w3, w4].sort()).toEqual(all.map((w) => w.id).sort())
  const nameOf = (id: string) => (all.find((w) => w.id === id) as (typeof all)[number]).name

  // bd's side, before: its config and every workspace's .beads config/metadata.
  const bdSide = () => ({
    config: workspace.bd(["config", "list", "--json"]),
    files: all.flatMap((w) =>
      ["config.yaml", "metadata.json"].map((f) => {
        try {
          return `${w.id}/${f}:${createHash("sha256").update(readFileSync(join(w.beadsDir, f))).digest("hex")}`
        } catch {
          return `${w.id}/${f}:absent`
        }
      }),
    ),
  })
  const bdBefore = bdSide()

  await page.goto("/")
  const rail = page.getByTestId("workspace-rail")
  await expect(rail).toBeVisible()
  await expect.poll(() => railOrder(page)).toEqual([w1, w2, w3, w4])
  const item = (id: string) => rail.locator(`[data-testid="workspace-rail-item"][data-workspace-id="${id}"]`)

  // AC1: drag the 4th workspace onto the top half of the 1st.
  await item(w4).dragTo(item(w1), { targetPosition: { x: 40, y: 3 } })
  await expect.poll(() => railOrder(page)).toEqual([w4, w1, w2, w3])
  await expect(page.getByTestId("workspace-rail-announcer")).toHaveText(
    `${nameOf(w4)} moved to position 1 of 4`,
  )
  // AC3: saved in Beadbox's own registry.
  await expect.poll(() => registryOrder(registryPath)).toEqual([w4, w1, w2, w3])

  // AC2: keyboard. Focus w1's row and move it down twice with Alt+ArrowDown.
  const openW1 = rail.getByRole("button", { name: `Open ${nameOf(w1)}`, exact: true })
  await openW1.focus()
  await page.keyboard.press("Alt+ArrowDown")
  await expect.poll(() => railOrder(page)).toEqual([w4, w2, w1, w3])
  await expect(openW1).toBeFocused()
  await page.keyboard.press("Alt+ArrowDown")
  await expect.poll(() => railOrder(page)).toEqual([w4, w2, w3, w1])
  await expect(openW1).toBeFocused()
  await expect(page.getByTestId("workspace-rail-announcer")).toHaveText(
    `${nameOf(w1)} moved to position 4 of 4`,
  )
  await expect.poll(() => registryOrder(registryPath)).toEqual([w4, w2, w3, w1])

  // AC3: a restart. Kill this worker's sidecar, start a new one, open a new page.
  sidecar.kill()
  await sidecar.waitExit()
  await sidecar.spawn()
  const relaunched = await page.context().newPage()
  await sidecar.attach(relaunched)
  await relaunched.goto("/")
  await expect(relaunched.getByTestId("workspace-rail")).toBeVisible()
  await expect.poll(() => railOrder(relaunched)).toEqual([w4, w2, w3, w1])
  await relaunched.close()

  // Nothing was written to bd.
  expect(bdSide()).toEqual(bdBefore)
})
