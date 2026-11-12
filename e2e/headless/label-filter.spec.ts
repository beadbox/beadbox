// beadbox-ymx (GH #70): Filter the bead list by label end-to-end against the
// real sidecar + Dolt workspace:
//   1. Label filter lists workspace labels returned by bd, matches
//      `bd list --label` and `bd list --label-any`, preserves ancestor context,
//      composes with Status and Search, and clears cleanly.
//   2. A label added via `bd update --add-label` shows up live in the filter,
//      selection persists across reload, and resets cleanly on workspace switch.

import { expect, test } from "../fixtures/harness"
import { type Listed, openTree, renderedIds } from "./helpers"

test("filters by single and multiple labels matching bd list, preserves ancestors, and composes with status and search", async ({
  page,
  workspace,
}) => {
  const initialBeads = workspace.bdJson<Listed[]>([
    "list",
    "--status",
    "all",
    "--limit",
    "0",
    "--flat",
  ])
  const epic = initialBeads.find((b) => b.issue_type === "epic")
  const highPriority = initialBeads.find((b) => b.title === "High Priority Task")
  const inProgress = initialBeads.find((b) => b.title === "In Progress Task")
  const criticalBug = initialBeads.find((b) => b.title === "Critical Bug")
  const searchAlpha = initialBeads.find((b) => b.title === "Search Target Alpha")
  if (!epic || !highPriority || !inProgress || !criticalBug || !searchAlpha) {
    throw new Error("expected standard fixture beads missing")
  }

  let nestedId: string | null = null
  const addedLabels: Array<{ id: string; label: string }> = []
  const addLabel = (id: string, label: string) => {
    workspace.bd(["update", id, "--add-label", label])
    addedLabels.push({ id, label })
  }

  try {
    // Seed 1-label, 2-label, standalone, and nested-child beads while leaving
    // Critical Bug and Completed Task unlabelled.
    addLabel(highPriority.id, "ymx-fe")
    addLabel(inProgress.id, "ymx-fe")
    addLabel(inProgress.id, "ymx-urg")
    addLabel(searchAlpha.id, "ymx-be")

    const created = workspace.bdJson<{ id: string }>([
      "create",
      "--title",
      "Nested Labelled Subtask",
      "--type",
      "task",
      "--priority",
      "2",
      "--parent",
      criticalBug.id,
    ])
    nestedId = created.id
    addLabel(nestedId, "ymx-deep")

    const allBeads = await openTree(page, workspace)
    // Expand Critical Bug's subtasks so the nested child is part of the open tree.
    await page.locator(`[data-item-id="${criticalBug.id}"] .bead-row-id button`).first().click()
    await expect.poll(() => renderedIds(page)).toEqual(allBeads.map((b) => b.id).sort())

    const labelFilterBtn = page.getByRole("button", { name: "Label filter" })
    await expect(labelFilterBtn).toContainText("All Labels")

    // 1. Label filter lists the workspace labels returned by bd.
    await labelFilterBtn.click()
    for (const label of ["ymx-be", "ymx-deep", "ymx-fe", "ymx-urg"]) {
      await expect(page.getByRole("checkbox", { name: label, exact: true })).toBeVisible()
    }

    // 2. Single label matches `bd list --label ymx-fe` + parent epic context.
    await page.locator("[data-multi-select-row]").filter({ hasText: "ymx-fe" }).click()
    const feMatches = workspace.bdJson<Listed[]>([
      "list",
      "--label",
      "ymx-fe",
      "--status",
      "all",
      "--limit",
      "0",
      "--flat",
    ])
    expect(feMatches.map((b) => b.id).sort()).toEqual([highPriority.id, inProgress.id].sort())
    await expect(labelFilterBtn).toContainText("ymx-fe")
    await expect
      .poll(() => renderedIds(page))
      .toEqual([...new Set([...feMatches.map((b) => b.id), epic.id])].sort())

    // Multi-label ANY matching (`ymx-fe` OR `ymx-be`) agrees with `bd list --label-any`.
    await page.locator("[data-multi-select-row]").filter({ hasText: "ymx-be" }).click()
    const anyMatches = workspace.bdJson<Listed[]>([
      "list",
      "--label-any",
      "ymx-fe,ymx-be",
      "--status",
      "all",
      "--limit",
      "0",
      "--flat",
    ])
    expect(anyMatches.map((b) => b.id).sort()).toEqual(
      [highPriority.id, inProgress.id, searchAlpha.id].sort(),
    )
    await expect(labelFilterBtn).toContainText("2 labels")
    await expect
      .poll(() => renderedIds(page))
      .toEqual([...new Set([...anyMatches.map((b) => b.id), epic.id])].sort())

    // 3. Ancestor preservation: selecting `ymx-deep` keeps unlabelled epic AND
    //    unlabelled parent task (`Critical Bug`) visible as context.
    await page.locator("[data-multi-select-row]").filter({ hasText: "All Labels" }).click()
    await expect(labelFilterBtn).toContainText("All Labels")
    await page.locator("[data-multi-select-row]").filter({ hasText: "ymx-deep" }).click()
    await page.keyboard.press("Escape")

    const deepMatches = workspace.bdJson<Listed[]>([
      "list",
      "--label",
      "ymx-deep",
      "--status",
      "all",
      "--limit",
      "0",
      "--flat",
    ])
    expect(deepMatches.map((b) => b.id)).toEqual([nestedId])
    await expect
      .poll(() => renderedIds(page))
      .toEqual([epic.id, criticalBug.id, nestedId].sort())

    // 4. Composition with Status and Search + clearing.
    await labelFilterBtn.click()
    await page.locator("[data-multi-select-row]").filter({ hasText: "All Labels" }).click()
    await page.locator("[data-multi-select-row]").filter({ hasText: "ymx-fe" }).click()
    await page.keyboard.press("Escape")

    await page.getByRole("button", { name: "Status filter" }).click()
    await page.locator("[data-multi-select-row]").filter({ hasText: /^Open$/ }).click()
    await page.keyboard.press("Escape")
    await expect.poll(() => renderedIds(page)).toEqual([epic.id, inProgress.id].sort())

    const searchInput = page.locator("[data-search-input]")
    await searchInput.fill("In Progress")
    await expect.poll(() => renderedIds(page)).toEqual([epic.id, inProgress.id].sort())
    await searchInput.fill("NoSuchBeadTitle")
    await expect.poll(() => renderedIds(page)).toEqual([])

    // Clear Search, Status, and Label -> full workspace tree returns.
    await searchInput.fill("")
    await page.getByRole("button", { name: "Status filter" }).click()
    await page.locator("[data-multi-select-row]").filter({ hasText: /^Open$/ }).click()
    await page.keyboard.press("Escape")
    await labelFilterBtn.click()
    await page.locator("[data-multi-select-row]").filter({ hasText: "All Labels" }).click()
    await page.keyboard.press("Escape")
    await expect.poll(() => renderedIds(page)).toEqual(allBeads.map((b) => b.id).sort())
  } finally {
    if (nestedId) {
      try {
        workspace.bd(["delete", nestedId, "--force"])
      } catch {
        // best-effort cleanup
      }
    }
    for (const { id, label } of addedLabels) {
      if (id === nestedId) continue
      try {
        workspace.bd(["update", id, "--remove-label", label])
      } catch {
        // best-effort cleanup
      }
    }
  }
})

test("adds bd labels live, persists across reload, and resets cleanly on workspace switch", async ({
  page,
  workspace,
  statusesWorkspace,
}) => {
  const allBeads = await openTree(page, workspace)
  const searchAlpha = allBeads.find((b) => b.title === "Search Target Alpha")
  if (!searchAlpha) throw new Error("fixture bead 'Search Target Alpha' missing")

  try {
    // 1. A label added via `bd` outside the UI appears live in the Label filter.
    workspace.bd(["update", searchAlpha.id, "--add-label", "ymx-live"])
    const labelFilterBtn = page.getByRole("button", { name: "Label filter" })
    await labelFilterBtn.click()
    await expect(page.getByRole("checkbox", { name: "ymx-live", exact: true })).toBeVisible({
      timeout: 10_000,
    })
    await page.locator("[data-multi-select-row]").filter({ hasText: "ymx-live" }).click()
    await page.keyboard.press("Escape")

    const liveMatches = workspace.bdJson<Listed[]>([
      "list",
      "--label",
      "ymx-live",
      "--status",
      "all",
      "--limit",
      "0",
      "--flat",
    ])
    expect(liveMatches.map((b) => b.id)).toEqual([searchAlpha.id])
    await expect.poll(() => renderedIds(page)).toEqual([searchAlpha.id])

    // 2. Persists across page reload on the same workspace.
    await page.reload()
    await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(
      workspace.name,
    )
    await expect(page.getByRole("button", { name: "Label filter" })).toContainText("ymx-live")
    await expect.poll(() => renderedIds(page)).toEqual([searchAlpha.id])

    // 3. Resets cleanly to "All Labels" when switching workspaces via the rail.
    const statusesAll = statusesWorkspace.bdJson<Listed[]>([
      "list",
      "--status",
      "all",
      "--limit",
      "0",
      "--flat",
    ])
    await page.getByRole("button", { name: `Open ${statusesWorkspace.name}` }).click()
    await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(
      statusesWorkspace.name,
    )
    await expect(page.getByRole("button", { name: "Label filter" })).toContainText("All Labels")
    await expect.poll(() => renderedIds(page)).toEqual(statusesAll.map((b) => b.id).sort())
  } finally {
    try {
      workspace.bd(["update", searchAlpha.id, "--remove-label", "ymx-live"])
    } catch {
      // best-effort cleanup
    }
  }
})
