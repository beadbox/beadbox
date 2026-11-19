// beadbox-9sa: the comment thread never moves on its own. A comment arriving
// while the reader is further up the thread leaves what they are reading where
// it is; there is no jump pill; the keyboard still scrolls the thread.
import { expect, test } from "../fixtures/harness"
import { type Listed, openDetail, openTree } from "./helpers"

test("a new comment never moves the thread; no jump pill; keyboard still scrolls", async ({ page, workspace: ws }) => {
  test.setTimeout(90_000)
  const listed = ws.bdJson<Listed[]>(["list", "--status", "all", "--limit", "0", "--flat"])
  const target = listed.find((b) => b.title === "Critical Bug")!
  const body = "This comment is long enough to take up some room in the thread. ".repeat(4)
  for (let i = 1; i <= 24; i++) ws.bd(["comments", "add", target.id, `Seed comment ${i}. ${body}`])

  await openTree(page, ws)
  await openDetail(page, target)
  await expect(page.getByText("Seed comment 24.", { exact: false })).toBeVisible()

  // Scroll the thread's container to its middle and pick the comment in view.
  const probe = page.getByText("Seed comment 12.", { exact: false })
  const measure = () =>
    probe.evaluate((el) => {
      let c: HTMLElement | null = el.parentElement
      while (c && !(c.scrollHeight > c.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(c).overflowY))) c = c.parentElement
      if (!c) throw new Error("no scroll container")
      return { offset: el.getBoundingClientRect().top - c.getBoundingClientRect().top, scrollTop: c.scrollTop }
    })
  await probe.evaluate((el) => el.scrollIntoView({ block: "center" }))
  await page.waitForTimeout(800)
  const before = await measure()
  expect(Math.abs(before.offset)).toBeLessThan(2000)

  // No jump pill while reading mid-thread.
  await expect(page.getByRole("button", { name: /^(Oldest|Latest|First) comment$/ })).toHaveCount(0)

  // A comment arrives (from bd: a live one, or my own from the terminal).
  ws.bd(["comments", "add", target.id, "Live comment arrives while reading"])
  await expect(page.getByText("Live comment arrives while reading")).toBeAttached({ timeout: 15_000 })
  await page.waitForTimeout(1500) // longer than any jump timer + smooth scroll
  const after = await measure()
  expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(2)
  await expect(page.getByRole("button", { name: /^(Oldest|Latest|First) comment$/ })).toHaveCount(0)

  // A second arrival, still put.
  ws.bd(["comments", "add", target.id, "Second live comment"])
  await expect(page.getByText("Second live comment")).toBeAttached({ timeout: 15_000 })
  await page.waitForTimeout(1500)
  expect(Math.abs((await measure()).offset - before.offset)).toBeLessThanOrEqual(2)

  // The keyboard still moves through the thread (j / ArrowDown in the detail panel).
  await probe.click()
  const start = (await measure()).scrollTop
  for (let i = 0; i < 3; i++) await page.keyboard.press("j")
  await expect.poll(async () => (await measure()).scrollTop).not.toBe(start)
})
