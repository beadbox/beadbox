// beadbox-kqiv (found by beadbox-cq58): a molecule's phases must not collapse
// and re-form when the workspace changes.
//
// The molecule view groups steps into phases from their blocked-by edges. On
// every change the tree used to arrive WITHOUT blocked-by and get it patched in
// by a second request a moment later, so for a few frames every step sat in
// Phase 1 and the later phases' rows were torn down and rebuilt. Any write in
// the workspace did it, not only a write to the molecule.
//
// The recorder samples the phase headers on every animation frame and counts,
// with a MutationObserver, the molecule's step rows removed from the DOM, from
// just before one bd write until the written priority is on screen and has
// settled. Synthetic data: the test builds the molecule and a plain epic of the
// same shape (three steps chained by blocks).

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"
import type { HarnessWorkspace } from "../fixtures/harness"

type Recording = { phaseStates: string[]; removedStepRows: number; frames: number }

/** Three steps under a root, step 2 blocked by step 1 and step 3 by step 2. */
function chain(workspace: HarnessWorkspace, rootId: string, title: string): string[] {
  const ids = [1, 2, 3].map(
    (n) =>
      workspace.bdJson<{ id: string }>([
        "create", `${title} step ${n}`, "-t", "task", "-p", "2", "--parent", rootId, "--no-inherit-labels",
      ]).id,
  )
  workspace.bd(["dep", "add", ids[1], ids[0]])
  workspace.bd(["dep", "add", ids[2], ids[1]])
  return ids
}

async function startRecording(page: Page, stepIds: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const steps = new Set(ids)
    const rec = { phaseStates: [] as string[], removedStepRows: 0, frames: 0, stop: false }
    ;(window as unknown as { __kqiv: typeof rec }).__kqiv = rec
    const stepRowsIn = (nodes: NodeList) => {
      let n = 0
      nodes.forEach((node) => {
        if (!(node instanceof Element)) return
        const rows = [node, ...Array.from(node.querySelectorAll("[data-item-id]"))]
        n += rows.filter((el) => steps.has(el.getAttribute("data-item-id") ?? "")).length
      })
      return n
    }
    const observer = new MutationObserver((records) => {
      for (const r of records) rec.removedStepRows += stepRowsIn(r.removedNodes)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const tick = () => {
      if (rec.stop) return observer.disconnect()
      rec.frames++
      const headers = Array.from(document.querySelectorAll("span"))
        .map((s) => s.textContent ?? "")
        .filter((t) => /^Phase \d+$/.test(t))
        .join(",")
      if (rec.phaseStates[rec.phaseStates.length - 1] !== headers) rec.phaseStates.push(headers)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, stepIds)
}

async function stopRecording(page: Page): Promise<Recording> {
  return page.evaluate(() => {
    const rec = (window as unknown as { __kqiv: Recording & { stop: boolean } }).__kqiv
    rec.stop = true
    return { phaseStates: rec.phaseStates, removedStepRows: rec.removedStepRows, frames: rec.frames }
  })
}

/** Write a priority with bd and record until the tree shows it, plus a settle. */
async function recordWrite(page: Page, workspace: HarnessWorkspace, stepIds: string[], writeId: string) {
  const priority = page.locator(`[data-item-id="${writeId}"] .bead-row-priority`)
  const before = await priority.innerText()
  await startRecording(page, stepIds)
  workspace.bd(["update", writeId, "--priority", "0"])
  await expect(priority).not.toHaveText(before, { timeout: 10_000 })
  // The old second pass landed one request after the tree: well inside this.
  await page.waitForTimeout(1_500)
  return stopRecording(page)
}

async function expand(page: Page, id: string) {
  const row = page.locator(`[data-item-id="${id}"]`)
  await expect(row).toBeVisible()
  await row.locator("button").first().click()
}

test("a molecule's phases stay put through a write to it and a write elsewhere", async ({ page, workspace }) => {
  const prefix = workspace.bdJson<Array<{ id: string }>>(["list", "--status", "all", "--limit", "1", "--flat"])[0].id.split("-")[0]
  const plain = workspace.bdJson<{ id: string }>(["create", "Plain chain", "-t", "epic", "-p", "2"]).id
  const plainSteps = chain(workspace, plain, "Plain")
  const mol = workspace.bdJson<{ id: string }>([
    "create", "Synthetic molecule", "-t", "epic", "-p", "2", "--id", `${prefix}-mol-kqiv`,
  ]).id
  const molSteps = chain(workspace, mol, "Mol")

  await page.goto("/")
  await expand(page, plain)
  await expand(page, mol)
  const allPhases = "Phase 1,Phase 2,Phase 3"
  await expect(page.locator(`[data-item-id="${molSteps[2]}"]`)).toBeVisible()
  // The initial load's blocked-by must be in before recording starts.
  await expect
    .poll(() => page.$$eval("span", (s) => s.map((e) => e.textContent).filter((t) => /^Phase \d+$/.test(t ?? "")).join(",")))
    .toBe(allPhases)

  const toMolecule = await recordWrite(page, workspace, molSteps, molSteps[2])
  expect(toMolecule.frames).toBeGreaterThan(10) // the recorder ran
  expect(toMolecule.phaseStates).toEqual([allPhases])
  expect(toMolecule.removedStepRows).toBe(0)

  const elsewhere = await recordWrite(page, workspace, molSteps, plainSteps[0])
  expect(elsewhere.frames).toBeGreaterThan(10)
  expect(elsewhere.phaseStates).toEqual([allPhases])
  expect(elsewhere.removedStepRows).toBe(0)
})
