// beadbox-9d4: bead rows show the T-shirt size bd's estimate implies, the
// revised estimate (metadata estimate_revised_min) wins, and a bead with no
// estimate shows the unsized mark. Checked against real bd writes.
import { expect, test } from "../fixtures/harness"
import { type Listed, openTree } from "./helpers"

test("rows show XS/S/M/L from bd estimates, revised wins, unsized and closed shown", async ({ page, workspace: ws }) => {
  test.setTimeout(60_000)
  const listed = ws.bdJson<Listed[]>(["list", "--status", "all", "--limit", "0", "--flat"])
  const epic = listed.find((b) => b.title === "E2E Test Epic")!
  const make = (title: string) => ws.bdJson<Listed>(["create", title, `--parent=${epic.id}`])
  const xs = make("Size probe XS")
  const s = make("Size probe S")
  const m = make("Size probe M")
  const l = make("Size probe L")
  const revised = make("Size probe revised")
  const unsized = make("Size probe unsized")
  const closed = make("Size probe closed")
  ws.bd(["update", xs.id, "--estimate=10"])
  ws.bd(["update", s.id, "--estimate=45"])
  ws.bd(["update", m.id, "--estimate=180"])
  ws.bd(["update", l.id, "--estimate=181"])
  ws.bd(["update", revised.id, "--estimate=30", "--set-metadata=estimate_revised_min=240"])
  ws.bd(["update", closed.id, "--estimate=90"])
  ws.bd(["close", closed.id])

  const expected: [Listed, string, string][] = [
    [xs, "XS", "Size XS, about 10m"],
    [s, "S", "Size S, about 45m"],
    [m, "M", "Size M, about 3h"],
    [l, "L", "Size L, about 3h"],
    [revised, "L", "Size L, about 4h (revised)"],
    [unsized, "?", "Unsized: no estimate"],
    [closed, "M", "Size M, about 2h"],
  ]
  // bd is the source: the estimates landed as written.
  const shown = ws.bdJson<{ id: string; estimated_minutes?: number }[]>(["show", revised.id, l.id])
  expect(shown.map((b) => b.estimated_minutes)).toEqual([30, 181])

  const check = async (rowFor: (b: Listed) => import("@playwright/test").Locator) => {
    for (const [bead, text, name] of expected) {
      const badge = rowFor(bead).getByRole("img", { name, exact: true })
      await expect(badge).toBeVisible()
      await expect(badge).toHaveText(text)
    }
  }

  await openTree(page, ws)
  await check((b) => page.locator(`[data-item-id="${b.id}"]`))

  await page.goto("/all-projects")
  await expect(page.getByRole("heading", { name: "All projects", exact: true })).toBeVisible()
  await check((b) => page.locator("[data-item-id]").filter({ hasText: b.title }).first())
})
