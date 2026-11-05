import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test } from "../fixtures/harness"
import { childEnv, findBd } from "../fixtures/dolt-server"

// The registry belongs to the whole worker: put it back after the test, pass
// or fail, so later specs never see this test's extra projects.
let restoreRegistry: (() => void) | undefined
test.afterEach(() => {
  restoreRegistry?.()
  restoreRegistry = undefined
})

// Each project's own color for "open" (beadbox-t6x): A red, B blue.
const OPEN_COLOR = ["#ff0000", "#0000ff"]

// Real, independent embedded stores, not exports or copies of demo tasks.
test("aggregate isolates duplicate IDs, filters, CLI updates, failures and tab switches", async ({ page, workspace }, testInfo) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(15_000)
  const root = dirname(workspace.registryPath)
  const env = childEnv({ BD_NON_INTERACTIVE: "1" })
  const run = (folder: string, args: string[]) => execFileSync(findBd(), args, { cwd: folder, env, encoding: "utf8", timeout: 30_000 })
  const projects = ["Aggregate A", "Aggregate B"].map((name, index) => {
    const folder = join(root, `aggregate-${index}`)
    mkdirSync(folder, { recursive: true })
    run(folder, ["init", "--non-interactive", "--prefix=shared", "--skip-hooks"])
    run(folder, ["create", `${name} Epic`, "--id=shared-epic", "--type=epic"])
    run(folder, ["create", `${name} Task — Проверка`, "--id=shared-task"])
    run(folder, ["update", "shared-task", "--parent=shared-epic"])
    run(folder, ["create", `${name} blocker`, "--id=shared-block"])
    run(folder, ["dep", "add", "shared-task", "shared-block"])
    return { id: `aggregate-${index}`, name, folder, local: { path: join(folder, ".beads") }, server: null, mode: "embedded", addedAt: new Date().toISOString(), statusColors: { open: OPEN_COLOR[index] } }
  })
  const original = readFileSync(workspace.registryPath, "utf8")
  restoreRegistry = () => writeFileSync(workspace.registryPath, original)
  const registry = JSON.parse(original)
  registry.workspaces.push(...projects)
  writeFileSync(workspace.registryPath, JSON.stringify(registry))
  const [a, b] = projects
  const row = (project: string, bead = "shared-task") => page.locator(`[data-project-id="${project}"][data-bead-id="${bead}"]`)
  const detail = () => page.getByRole("region", { name: "Details: Aggregate A" })

  await page.goto("/all-projects")
  await expect(page.getByRole("heading", { name: "All projects", exact: true })).toBeVisible()
  await expect(row(a.id)).toContainText("Проверка")
  await expect(row(a.id)).toBeVisible()
  await expect(row(b.id)).toBeVisible()
  await expect(row(a.id, "shared-epic")).toBeVisible()

  // beadbox-t6x: each row's status badge uses its own project's color for the
  // same status, the way each project's own board shows it.
  const openBadge = (project: string) =>
    row(project, "shared-epic").locator('[data-status="open"][data-status-role="badge"]')
  const background = (el: import("@playwright/test").Locator) =>
    el.evaluate((node) => getComputedStyle(node).backgroundColor)
  await expect.poll(() => background(openBadge(a.id))).toBe("rgba(255, 0, 0, 0.2)")
  await expect.poll(() => background(openBadge(b.id))).toBe("rgba(0, 0, 255, 0.2)")

  await expect(row(a.id).getByTestId("project-badge")).toHaveText("Aggregate A")
  await row(a.id).getByRole("checkbox").click()
  await expect(row(a.id).getByRole("checkbox")).toBeChecked()
  await expect(row(b.id).getByRole("checkbox")).not.toBeChecked()
  await page.getByRole("button", { name: "Set status of selected" }).click()
  await page.getByRole("menuitem", { name: "In Progress", exact: true }).click()
  await expect.poll(() => JSON.parse(run(a.folder, ["show", "shared-task", "--json"]))[0].status).toBe("in_progress")
  expect(JSON.parse(run(b.folder, ["show", "shared-task", "--json"]))[0].status).toBe("open")
  const checkSettings = async () => {
    const button = page.getByRole("button", { name: "Settings", exact: true })
    await expect(button).toBeVisible()
    await button.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByRole("dialog").getByText("General", { exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
  }
  await checkSettings()
  await page.setViewportSize({ width: 760, height: 800 })
  await checkSettings()
  await page.setViewportSize({ width: 1440, height: 900 })

  // Source filter intersects with the existing search filter.
  await page.getByRole("button", { name: "Project filter" }).click()
  await page.locator("button[data-multi-select-row]").filter({ hasText: "All projects" }).click()
  await page.locator("button[data-multi-select-row]").filter({ hasText: "Aggregate A" }).click()
  await page.keyboard.press("Escape")
  await expect(row(a.id)).toBeVisible()
  await expect(row(b.id)).toHaveCount(0)
  const search = page.getByPlaceholder(/search/i).first()
  await search.fill("Task")
  await expect(row(a.id, "shared-epic")).toHaveCount(0)
  await search.fill("")
  await page.getByRole("button", { name: "Project filter" }).click()
  await page.locator("button[data-multi-select-row]").filter({ hasText: "Aggregate B" }).click()
  await page.keyboard.press("Escape")
  await expect(row(b.id)).toBeVisible()

  await row(a.id).click()
  await detail().getByRole("button", { name: "shared-block", exact: true }).click()
  await expect(detail().getByText("Aggregate A blocker", { exact: true })).toBeVisible()
  await row(a.id).click()
  await detail().getByRole("button", { name: "Add label" }).click()
  await page.getByRole("combobox", { name: "New label" }).fill("aggregate-ui")
  await page.keyboard.press("Enter")
  const shown = (folder: string) => JSON.parse(run(folder, ["show", "shared-task", "--json"]))[0]
  await expect.poll(() => shown(a.folder).labels ?? []).toContain("aggregate-ui")
  expect(shown(b.folder).labels ?? []).not.toContain("aggregate-ui")
  await detail().getByRole("textbox", { name: "Comment", exact: true }).fill("Only in project A — комментарий")
  await detail().getByRole("button", { name: "Add comment" }).click()
  await expect(detail().getByText("Only in project A — комментарий", { exact: true })).toBeVisible()
  expect(run(b.folder, ["comments", "shared-task", "--json"])).not.toContain("Only in project A — комментарий")

  run(a.folder, ["update", "shared-task", "--title=CLI changed A"])
  await expect(row(a.id)).toContainText("CLI changed A", { timeout: 15_000 })
  await expect(row(b.id)).toContainText("Aggregate B Task")
  // Wait through another complete refresh: loaded tasks must not disappear.
  await page.waitForTimeout(6_000)
  await expect(row(a.id)).toContainText("CLI changed A")
  await expect(row(b.id)).toBeVisible()

  renameSync(b.local.path, `${b.local.path}-offline`)
  try {
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(page.getByRole("alert").filter({ hasText: "Aggregate B" })).toBeVisible()
    await expect(row(a.id)).toBeVisible()
    await page.getByRole("button", { name: "Open Aggregate A", exact: true }).click()
    await expect(page).toHaveURL(/\/$|\/\?/)
    await expect(page.getByText("Aggregate A Epic", { exact: true }).first()).toBeVisible()
    await checkSettings()
    await page.setViewportSize({ width: 760, height: 800 })
    await checkSettings()
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.getByText("Aggregate B Task — Проверка", { exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "All projects", exact: true }).click()
    await expect(row(a.id)).toContainText("CLI changed A")
  } finally { renameSync(`${b.local.path}-offline`, b.local.path) }
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(row(b.id)).toBeVisible()
  await row(b.id).click()
  await expect(page.getByRole("region", { name: "Details: Aggregate B" }).getByText("Only in project A — комментарий", { exact: true })).toHaveCount(0)
  // The detail pane uses its source's colors: B's open status text takes the
  // color B's own stylesheet gives it, which A's never would.
  const paneStatus = page
    .getByRole("region", { name: "Details: Aggregate B" })
    .locator('[data-status="open"][data-status-role="text"]')
    .first()
  const scopedTextColor = (project: string) =>
    page.evaluate((id) => {
      const css = document.querySelector(`style[data-beadbox-status-colors-project="${id}"]`)?.textContent ?? ""
      const m = css.match(/\[data-status="open"\]\[data-status-role="text"\]\{color:([^}]+)\}/)
      if (!m) return null
      const probe = document.createElement("span")
      probe.style.color = m[1]
      document.body.append(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return value
    }, project)
  const expectedB = await scopedTextColor(b.id)
  expect(expectedB).not.toBeNull()
  expect(expectedB).not.toBe(await scopedTextColor(a.id))
  await expect.poll(() => paneStatus.evaluate((node) => getComputedStyle(node).color)).toBe(expectedB)
  // Colors are Beadbox's own setting: bd never sees them.
  for (const folder of [a.folder, b.folder]) expect(run(folder, ["show", "shared-epic", "--json"])).not.toContain("#ff0000")
  await page.reload()
  await expect(row(a.id)).toBeVisible()
  await expect(row(b.id)).toBeVisible()
  await checkSettings()
  await page.screenshot({ path: testInfo.outputPath("all-projects.png"), fullPage: true })
})
