// beadbox-d6l: "Archive bead" removes the row at once; a failed archive brings
// it back where it was with an error naming the bead. Against the real sidecar
// and bd. Two faults are injected in the test transport only, on the one
// archiveBead frame: HOLD (the frame is sent when the test says, so the row can
// be seen gone before the write) and FAIL (the frame names a bead that does not
// exist, so bd itself refuses the write). Every other call passes straight through.
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"
import { type Listed, openTree } from "./helpers"

const MISSING = "e2e-zzz9"

async function installFaults(page: Page): Promise<void> {
  await page.addInitScript((missing) => {
    type Bridge = { write: (data: unknown) => Promise<unknown> }
    type Ctl = { hold: string | null; fail: string | null; release: (() => void) | null; seen: number }
    const w = window as unknown as { __beadboxTestBridge: Bridge; __d6l: Ctl }
    const bridge = w.__beadboxTestBridge
    const write = bridge.write.bind(bridge)
    w.__d6l = { hold: null, fail: null, release: null, seen: 0 }
    bridge.write = (data: unknown) => {
      const ctl = w.__d6l
      const text = typeof data === "string" ? data : JSON.stringify(data)
      if (!text.includes("archiveBead")) return write(data)
      ctl.seen++
      let out: unknown = data
      if (ctl.fail && text.includes(ctl.fail)) {
        const swapped = text.split(ctl.fail).join(missing)
        out = typeof data === "string" ? swapped : JSON.parse(swapped)
        ctl.fail = null
      }
      if (ctl.hold && text.includes(ctl.hold)) {
        ctl.hold = null
        return new Promise((resolve) => {
          ctl.release = () => resolve(write(out))
        })
      }
      return write(out)
    }
  }, MISSING)
}

const labelsOf = (ws: { bdJson: <T>(a: string[]) => T }, id: string): string[] => {
  const shown = ws.bdJson<Listed[] | Listed>(["show", id])
  return (Array.isArray(shown) ? shown[0] : shown).labels ?? []
}
const domIds = (page: Page) =>
  page.$$eval("[data-item-id]", (els) => els.map((e) => e.getAttribute("data-item-id") ?? "").filter((id) => id && id !== "_standalone"))

test("archive leaves at once, holds through the write, and a failure comes back with an error", async ({ page, workspace: ws }) => {
  test.setTimeout(60_000)
  await installFaults(page)
  const beads = await openTree(page, ws)
  const a = beads.find((b) => b.title === "High Priority Task")!
  const b = beads.find((b) => b.title === "Search Target Alpha")!
  try {
    // 1. Success, with the write held: the row is gone BEFORE bd is even asked.
    await page.evaluate((id) => {
      ;(window as unknown as { __d6l: { hold: string } }).__d6l.hold = id
    }, a.id)
    await page.getByRole("button", { name: `Archive bead ${a.id}`, exact: true }).click()
    await expect(page.locator(`[data-item-id="${a.id}"]`)).toHaveCount(0)
    expect(labelsOf(ws, a.id)).not.toContain("archived")
    // A second click target is gone, so a double click can't reach a second call.
    expect(await page.evaluate(() => (window as unknown as { __d6l: { seen: number } }).__d6l.seen)).toBe(1)
    await page.evaluate(() => (window as unknown as { __d6l: { release: () => void } }).__d6l.release())
    await expect.poll(() => labelsOf(ws, a.id)).toContain("archived")
    await page.waitForTimeout(1500) // a live refresh lands; the row must not come back
    await expect(page.locator(`[data-item-id="${a.id}"]`)).toHaveCount(0)

    // 2. Failure, by keyboard: bd refuses; the row comes back in place and the error names it.
    const before = await domIds(page)
    await page.evaluate((id) => {
      ;(window as unknown as { __d6l: { fail: string } }).__d6l.fail = id
    }, b.id)
    const button = page.getByRole("button", { name: `Archive bead ${b.id}`, exact: true })
    await button.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByText(`Failed to archive ${b.id}`)).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => domIds(page)).toEqual(before)
    expect(labelsOf(ws, b.id)).not.toContain("archived")
  } finally {
    if (labelsOf(ws, a.id).includes("archived")) ws.bd(["update", a.id, "--remove-label=archived"])
  }
})

test("a real double-click on Archive archives exactly one bead", async ({ page, workspace: ws }) => {
  test.setTimeout(60_000)
  await openTree(page, ws)
  const archivedNow = () =>
    ws
      .bdJson<Listed[]>(["list", "--status", "all", "--limit", "0", "--flat"])
      .filter((x) => (x.labels ?? []).includes("archived"))
      .map((x) => x.id)
  const before = archivedNow()
  // The first visible bead row's archive button; the next row slides up under the pointer.
  const target = (await domIds(page)).find((id) => !id.startsWith("_") && id.includes("."))!
  try {
    await page.getByRole("button", { name: `Archive bead ${target}`, exact: true }).dblclick()
    await expect.poll(() => archivedNow().filter((id) => !before.includes(id))).toEqual([target])
    await page.waitForTimeout(1500) // any second archive would have landed by now
    expect(archivedNow().filter((id) => !before.includes(id))).toEqual([target])
  } finally {
    for (const id of archivedNow().filter((x) => !before.includes(x))) ws.bd(["update", id, "--remove-label=archived"])
  }
})

