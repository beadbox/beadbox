// beadbox-o3h: per-status colors, set in Settings > Workflow, applied
// everywhere a status is drawn, stored in Beadbox's own registry and never in
// bd. Synthetic fixtures only; run with --workers=1.
//
// Computed styles are compared two ways: against an exact rgba for a chosen
// color, and, for "unchanged" checks, against a clone of the same element
// with the data-status tags removed (what main renders: the same classes and
// no injected rule).

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Locator, Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"
import type { HarnessWorkspace } from "../fixtures/harness"
import { CUSTOM_STATUSES } from "../global-setup"
import { type Listed, openTree } from "./helpers"

const BUILTINS = ["open", "in_progress", "blocked", "deferred", "closed"]
const BUILTIN_DEFAULT_HEX = ["#ffffff", "#f59e0b", "#3b82f6", "#71717a", "#06b6d4", "#a855f7", "#10b981"]
const CUSTOM_NAMES = CUSTOM_STATUSES.split(",").map((s) => s.split(":")[0])
const SHOTS = process.env.O3H_SCREENSHOT_DIR

type Style = { bg: string; color: string; border: string }

function styleOf(loc: Locator): Promise<Style> {
  return loc.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor }
  })
}

/** The element's style with its status tags removed: what the classes alone give. */
function untaggedStyleOf(loc: Locator): Promise<Style> {
  return loc.evaluate((el) => {
    const clone = el.cloneNode(false) as HTMLElement
    clone.removeAttribute("data-status")
    clone.removeAttribute("data-status-role")
    clone.style.transition = "none"
    el.parentElement?.appendChild(clone)
    const cs = getComputedStyle(clone)
    const out = { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor }
    clone.remove()
    return out
  })
}

/** Badge transitions colors over 150ms: poll until it settles. */
async function expectStyle(loc: Locator, want: Partial<Style>): Promise<void> {
  await expect.poll(async () => {
    const got = await styleOf(loc)
    return Object.fromEntries(Object.keys(want).map((k) => [k, got[k as keyof Style]]))
  }).toEqual(want)
}

async function expectDefault(loc: Locator): Promise<void> {
  await expect.poll(async () => JSON.stringify(await styleOf(loc))).toBe(JSON.stringify(await untaggedStyleOf(loc)))
}

async function openWorkflow(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("tab", { name: "Workflow" }).click()
  await expect(page.getByRole("list", { name: "Status colors" })).toBeVisible()
}

function colorRow(page: Page, status: string): Locator {
  return page.locator(`[data-status-color-row="${status}"]`)
}

async function setHex(page: Page, status: string, hex: string): Promise<void> {
  // Chromium gives <input type="color"> the textbox role too: target the hex field.
  const field = colorRow(page, status).locator('input[type="text"]')
  await field.fill(hex)
  await field.press("Enter")
}

function registryColors(ws: HarnessWorkspace): Record<string, string> | undefined {
  const reg = JSON.parse(readFileSync(ws.registryPath, "utf-8"))
  return reg.workspaces.find((w: { id: string }) => w.id === ws.id)?.statusColors
}

function clearAllColors(ws: HarnessWorkspace): void {
  const reg = JSON.parse(readFileSync(ws.registryPath, "utf-8"))
  for (const w of reg.workspaces) delete w.statusColors
  writeFileSync(ws.registryPath, JSON.stringify(reg))
}

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[p.slice(dir.length)] = createHash("sha256").update(readFileSync(p)).digest("hex")
    }
  }
  walk(dir)
  return out
}

function isGreyish(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)
  return s < 0.25 || l > 0.93 || l < 0.08
}

async function switchTo(page: Page, ws: HarnessWorkspace): Promise<void> {
  await page.getByRole("button", { name: `Open ${ws.name}` }).click()
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(ws.name)
}

function firstWithStatus(beads: Listed[], status: string): Listed {
  const bead = beads.find((b) => b.status === status && b.issue_type !== "epic")
  if (!bead) throw new Error(`fixture has no non-epic bead in ${status}`)
  return bead
}

const badgeOf = (page: Page, id: string) => page.locator(`[data-item-id="${id}"] [data-status-role="badge"]`).first()

test.describe("status colors (beadbox-o3h)", () => {
  test.afterEach(({ workspace }) => clearAllColors(workspace))

  test("AC1 + AC4: every status has a color control; customs get distinct non-grey defaults", async ({
    page,
    statusesWorkspace: ws,
  }) => {
    await page.goto("/")
    await expect(page.locator("[data-item-id]").first()).toBeVisible()
    await switchTo(page, ws)
    await openWorkflow(page)
    for (const s of [...BUILTINS, ...CUSTOM_NAMES]) await expect(colorRow(page, s)).toBeVisible()
    // bd's other built-ins (pinned, hooked on bd 1.3) are not custom: they keep
    // main's blue fallback, with no generated color.
    for (const s of ["pinned", "hooked"]) {
      if ((await colorRow(page, s).count()) === 0) continue
      await expect(colorRow(page, s).locator('input[type="color"]')).toHaveValue("#3b82f6")
    }

    const customHex = await Promise.all(
      CUSTOM_NAMES.map((s) => colorRow(page, s).locator('input[type="color"]').inputValue()),
    )
    expect(new Set(customHex).size).toBe(CUSTOM_NAMES.length)
    for (const hex of customHex) {
      expect(isGreyish(hex)).toBe(false)
      expect(BUILTIN_DEFAULT_HEX).not.toContain(hex)
    }
    // ...and the list badge of a bead in that status shows it, with no user action.
    await page.keyboard.press("Escape")
    const beads = ws.bdJson<Listed[]>(["list", "--status", "all", "--limit", "0", "--flat"])
    const bead = firstWithStatus(beads, CUSTOM_NAMES[0])
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(customHex[0].slice(i, i + 2), 16))
    await expectStyle(badgeOf(page, bead.id), { bg: `rgba(${r}, ${g}, ${b}, 0.2)` })
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "customs-defaults.png") })
  })

  test("AC2: a chosen color shows on the list badge, filter row, Grouped header and pipeline tile; others unchanged", async ({
    page,
    workspace: ws,
  }) => {
    const beads = await openTree(page, ws)
    const open = firstWithStatus(beads, "open")
    const inProgress = firstWithStatus(beads, "in_progress")
    await expectDefault(badgeOf(page, open.id))

    await openWorkflow(page)
    await setHex(page, "open", "#ff0000")
    await page.keyboard.press("Escape")

    // List badge, at once, no reload.
    await expectStyle(badgeOf(page, open.id), { bg: "rgba(255, 0, 0, 0.2)", border: "rgba(255, 0, 0, 0.4)" })
    await expectDefault(badgeOf(page, inProgress.id))

    // Status filter row dot.
    await page.getByRole("button", { name: "Status filter" }).click()
    await expectStyle(page.locator('[data-multi-select-row] [data-status="open"][data-status-role="dot"]'), {
      bg: "rgb(255, 0, 0)",
    })
    await expectDefault(page.locator('[data-multi-select-row] [data-status="in_progress"][data-status-role="dot"]'))
    // Grouped view: the section header dot.
    await page.locator("[data-multi-select-row]").filter({ hasText: "Grouped" }).click()
    await page.keyboard.press("Escape")
    await expectStyle(page.locator('[data-group-status="open"] > div [data-status-role="dot"]').first(), {
      bg: "rgb(255, 0, 0)",
    })
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "grouped-open-red.png") })

    // Activity pipeline tile (a full navigation: colors come back from the registry).
    await page.goto("/activity")
    await expectStyle(page.locator('[data-stage="open"]'), { bg: "rgba(255, 0, 0, 0.2)" })
    await expectDefault(page.locator('[data-stage="in_progress"]'))
  })

  test("AC3: Reset restores every default", async ({ page, workspace: ws }) => {
    const beads = await openTree(page, ws)
    const open = firstWithStatus(beads, "open")
    const inProgress = firstWithStatus(beads, "in_progress")
    await openWorkflow(page)
    await setHex(page, "open", "#ff0000")
    await setHex(page, "in_progress", "#00ff00")
    await expect.poll(() => registryColors(ws)).toEqual({ open: "#ff0000", in_progress: "#00ff00" })
    await page.getByRole("button", { name: "Reset status colors" }).click()
    await expect.poll(() => registryColors(ws)).toBeUndefined()
    await page.keyboard.press("Escape")
    await expectDefault(badgeOf(page, open.id))
    await expectDefault(badgeOf(page, inProgress.id))
  })

  test("AC5: persists across a new sidecar and a fresh page, per workspace, and bd is untouched", async ({
    page,
    browser,
    baseURL,
    sidecar,
    workspace: ws,
    statusesWorkspace,
  }) => {
    const beadsBefore = hashTree(ws.beadsDir)
    const configBefore = ws.bd(["config", "list"])

    const beads = await openTree(page, ws)
    const open = firstWithStatus(beads, "open")
    await openWorkflow(page)
    await setHex(page, "open", "#ff0000")
    await expect.poll(() => registryColors(ws)).toEqual({ open: "#ff0000" })
    await page.keyboard.press("Escape")

    // bd: config and every file under .beads byte-identical.
    expect(ws.bd(["config", "list"])).toBe(configBefore)
    expect(hashTree(ws.beadsDir)).toEqual(beadsBefore)

    // Restart: a new sidecar process, a fresh browser context (no storage).
    const oldPid = sidecar.status().pid
    await page.close()
    sidecar.kill()
    await sidecar.waitExit()
    const newPid = await sidecar.spawn()
    expect(newPid).not.toBe(oldPid)
    const context = await browser.newContext({ baseURL })
    const fresh = await context.newPage()
    await sidecar.attach(fresh)
    try {
      await openTree(fresh, ws)
      await expectStyle(badgeOf(fresh, open.id), { bg: "rgba(255, 0, 0, 0.2)" })

      // Workspace B shows its own (default) colors, not A's.
      await switchTo(fresh, statusesWorkspace)
      await openWorkflow(fresh)
      await expect(colorRow(fresh, "open").locator('input[type="color"]')).toHaveValue("#ffffff")
      expect(registryColors(statusesWorkspace)).toBeUndefined()
    } finally {
      await context.close()
    }
  })

  test("AC4: a new custom status gets a fresh default; removing it drops its color", async ({
    page,
    statusesWorkspace: ws,
  }) => {
    const NEW = "o3h_new_status"
    try {
      await page.goto("/")
      await expect(page.locator("[data-item-id]").first()).toBeVisible()
      await switchTo(page, ws)
      await openWorkflow(page)

      const addAndSave = async () => {
        await page.getByLabel("Add a status").fill(NEW)
        await page.getByRole("button", { name: "Add status" }).click()
        await page.getByRole("button", { name: "Save custom statuses" }).click()
        await expect(colorRow(page, NEW)).toBeVisible()
      }
      const removeAndSave = async () => {
        await page.getByRole("button", { name: `Remove ${NEW}` }).click()
        await page.getByRole("button", { name: "Save custom statuses" }).click()
        await expect(colorRow(page, NEW)).toHaveCount(0)
      }

      await addAndSave()
      const all = [...BUILTINS, ...CUSTOM_NAMES]
      const others = await Promise.all(all.map((s) => colorRow(page, s).locator('input[type="color"]').inputValue()))
      const fresh = await colorRow(page, NEW).locator('input[type="color"]').inputValue()
      expect(isGreyish(fresh)).toBe(false)
      expect(others).not.toContain(fresh)
      expect(BUILTIN_DEFAULT_HEX).not.toContain(fresh)

      await setHex(page, NEW, "#123456")
      await expect.poll(() => registryColors(ws)?.[NEW]).toBe("#123456")
      await removeAndSave()
      await expect.poll(() => registryColors(ws)?.[NEW]).toBeUndefined()
      await addAndSave()
      await expect(colorRow(page, NEW).locator('input[type="color"]')).toHaveValue(fresh)
      expect(registryColors(ws)?.[NEW]).toBeUndefined()
    } finally {
      ws.bd(["config", "set", "status.custom", CUSTOM_STATUSES])
      clearAllColors(ws)
    }
  })

  test("AC6: the color field and Reset work by keyboard alone", async ({ page, workspace: ws }) => {
    await openTree(page, ws)
    await openWorkflow(page)
    const preview = colorRow(page, "open").locator('[data-status-role="badge"]')

    // Tab from the Workflow tab to the open row's hex field.
    await page.getByRole("tab", { name: "Workflow" }).focus()
    const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")
    for (let i = 0; i < 40 && (await focusedLabel()) !== "Open color hex"; i++) await page.keyboard.press("Tab")
    expect(await focusedLabel()).toBe("Open color hex")
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.type("#00ff00")
    await page.keyboard.press("Enter")
    await expectStyle(preview, { bg: "rgba(0, 255, 0, 0.2)" })

    for (let i = 0; i < 80 && (await focusedLabel()) !== "Reset status colors"; i++) await page.keyboard.press("Tab")
    expect(await focusedLabel()).toBe("Reset status colors")
    await page.keyboard.press("Space")
    await expectDefault(preview)
    await expect.poll(() => registryColors(ws)).toBeUndefined()
  })
})
