// Gates as rows in the molecule view (beadbox-wya0.2). The test pours its own
// synthetic molecule into the gates workspace: two step epics, gates from step
// gate fields (human, timer, gh:run) and a type:gate step; the human gate is
// resolved, the timer stays open so its due time shows.
// bd is the judge: the rows shown are the gates `bd list --include-gates`
// lists under the molecule, each in its own step with bd's kind and status.
//
// The gates workspace is shared by the worker's specs, so every gate this test
// makes is closed again at the end: the Waiting view keeps seeing only the
// seeded open gates.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/harness"
import type { HarnessWorkspace } from "../fixtures/harness"

type Row = { id: string; title: string; issue_type: string; status: string; parent?: string; await_type?: string }

function pour(ws: HarnessWorkspace): { molecule: string; steps: string[] } {
  const name = `mol-e2e-gates-${Date.now()}`
  mkdirSync(join(ws.beadsDir, "formulas"), { recursive: true })
  const formula = {
    formula: name,
    version: 1,
    type: "workflow",
    description: "Synthetic molecule with gates of each kind",
    steps: [
      {
        id: "s1", title: "Step one", type: "epic", children: [
          { id: "a1", title: "Build" },
          { id: "a2", title: "Review build", needs: ["a1"], gate: { type: "human" } },
          { id: "g1", title: "Approve release", type: "gate", needs: ["a2"] },
          { id: "a3", title: "Ship", needs: ["g1"] },
        ],
      },
      {
        id: "s2", title: "Step two", type: "epic", children: [
          { id: "b1", title: "Cool down", needs: ["a3"], gate: { type: "timer", timeout: "2h" } },
          { id: "b2", title: "Wait CI", needs: ["b1"], gate: { type: "gh:run", id: "ci.yml" } },
        ],
      },
    ],
  }
  writeFileSync(join(ws.beadsDir, "formulas", `${name}.formula.json`), JSON.stringify(formula))
  const poured = ws.bdJson<{ new_epic_id: string; id_mapping: Record<string, string> }>(["mol", "pour", name])
  return {
    molecule: poured.new_epic_id,
    steps: [poured.id_mapping[`${name}.s1`]!, poured.id_mapping[`${name}.s2`]!],
  }
}

function moleculeGates(ws: HarnessWorkspace, steps: string[]): Row[] {
  const all = ws.bdJson<Row[]>(["list", "--status", "all", "--limit", "0", "--flat", "--include-gates"])
  return all.filter((b) => b.issue_type === "gate" && b.parent && steps.includes(b.parent))
}

async function openGatesWorkspace(page: Page, ws: HarnessWorkspace): Promise<void> {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText("e2e-standard")
  await page.getByRole("button", { name: `Open ${ws.name}` }).click()
  await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(ws.name)
}

async function expand(page: Page, id: string): Promise<void> {
  const row = page.locator(`[data-item-id="${id}"]`).first()
  await expect(row).toBeVisible()
  // A molecule's step is a header that is itself the toggle (beadbox-e04o.1).
  if ((await row.getAttribute("data-step-header")) !== null) await row.click()
  else await row.locator("button").first().click()
}

test("each gate under a molecule is a row in its step, with bd's kind and status", async ({
  page,
  gatesWorkspace: ws,
}) => {
  const { molecule, steps } = pour(ws)
  const made = moleculeGates(ws, steps)
  try {
    const human = made.find((g) => g.await_type === "human")!
    const timer = made.find((g) => g.await_type === "timer")!
    ws.bd(["gate", "resolve", human.id, "--reason=e2e resolved"])
    const gates = moleculeGates(ws, steps)
    expect(gates).toHaveLength(4) // human, timer, gh:run, and the type:gate step
    expect(gates.filter((g) => g.status === "closed")).toHaveLength(1)

    await openGatesWorkspace(page, ws)
    await expand(page, molecule)
    for (const step of steps) await expand(page, step)

    for (const gate of gates) {
      // A molecule's step is a section: its header, then its rows (beadbox-e04o.1).
      const stepRow = page.locator(`[data-step-section="${gate.parent}"]`).first()
      const row = stepRow.locator(`[data-item-id="${gate.id}"]`)
      await expect(row).toBeVisible()
      await expect(row).toContainText(gate.title)
      const chip = row.getByTestId("gate-chip")
      await expect(chip).toHaveText(gate.await_type || "unknown")
      await expect(chip).toHaveClass(gate.status === "closed" ? /emerald/ : /amber/)
    }
    // An open timer shows its due time (2h from its creation).
    await expect(page.locator(`[data-item-id="${timer.id}"]`).getByTestId("gate-deadline")).toHaveText(/expires in/)
  } finally {
    for (const gate of moleculeGates(ws, steps).filter((g) => g.status !== "closed")) {
      ws.bd(["gate", "resolve", gate.id, "--reason=e2e cleanup"])
    }
  }
})
