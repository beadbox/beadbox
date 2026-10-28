// beadbox-e04o.1: a nested molecule in the Beads view. bd 1.3 pours a formula
// with nested steps as a root of type molecule whose children are step epics
// (ids under the workspace's -mol- prefix, parent = the root) holding the
// step's children; a step with no children is poured as a task. Each step is
// a phase of the molecule: a header with its children under it, in pour order.
// A step is never a molecule of its own.

import { afterEach, describe, expect, mock, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, render } from "@testing-library/react"

import { EpicTree } from "../components/epic-tree"
import { isStepFinished, stepCount, stepExpansionChanges } from "../lib/molecule-phases"
import { isMoleculePresentation } from "../lib/molecule-presentation"
import type { Bead, Epic } from "../lib/types"
import { MOLECULE_FLAT_TREE_HTML } from "./__golden__/molecule-flat-tree"

afterEach(cleanup)

const AT = new Date("2026-10-28T00:00:00Z")
const task = (id: string, over: Partial<Bead> = {}): Bead =>
  ({
    id,
    title: id,
    type: "task",
    status: "open",
    priority: "medium",
    labels: [],
    blockedBy: [],
    createdAt: AT,
    updatedAt: AT,
    ...over,
  }) as unknown as Bead
const epic = (id: string, over: Partial<Epic> = {}): Epic =>
  ({
    id,
    title: id,
    description: "",
    status: "open",
    priority: "medium",
    type: "epic",
    assignee: "",
    labels: [],
    createdAt: AT,
    updatedAt: AT,
    comments: [],
    children: [],
    childEpics: [],
    commentCount: 0,
    ...over,
  }) as unknown as Epic

// The e2e-molecules shape: s1 (3 children) and s2 (1 child) are step epics,
// s3 has no children so it is a loose task of the root.
function nestedRoot(): Epic {
  const s1 = epic("t-mol-s1", {
    title: "Step 1: bob prepares",
    parentId: "t-mol-root",
    children: [
      task("t-mol-c1a", { title: "Child 1a" }),
      task("t-mol-c1b", { title: "Child 1b" }),
      task("t-mol-c1c", { title: "Child 1c" }),
    ],
  })
  const s2 = epic("t-mol-s2", {
    title: "Step 2: ship",
    parentId: "t-mol-root",
    children: [task("t-mol-c2a", { title: "Child 2a" })],
  })
  return epic("t-mol-root", {
    title: "nest-flow",
    type: "molecule",
    children: [task("t-mol-s3", { title: "Step 3: empty", parentId: "t-mol-root" })],
    childEpics: [s1, s2],
  })
}

const renderTree = (epics: Epic[], expanded: string[]) =>
  render(
    <EpicTree
      epics={epics}
      expandedEpics={new Set(expanded)}
      onToggleEpic={mock(() => {})}
      onBeadClick={mock(() => {})}
    />,
  )

const ids = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((el) => el.getAttribute("data-item-id"))

describe("the step-is-a-phase rule (beadbox-e04o.1)", () => {
  test("an epic with -mol- in its id is a legacy molecule root only with no parent", () => {
    expect(isMoleculePresentation({ id: "bb-mol-abc", type: "epic" })).toBe(true)
    expect(isMoleculePresentation({ id: "bb-mol-abc", type: "epic", parentId: undefined })).toBe(
      true,
    )
    expect(
      isMoleculePresentation({ id: "spk-mol-s1", type: "epic", parentId: "spk-mol-root" }),
    ).toBe(false)
    expect(isMoleculePresentation({ id: "spk-mol-root", type: "molecule" })).toBe(true)
    expect(isMoleculePresentation({ id: "spk-e1", type: "epic" })).toBe(false)
  })
})

describe("a nested molecule in the tree (beadbox-e04o.1)", () => {
  test("one header per step, in pour order, after the loose task's phase; no step is a molecule", () => {
    const { container } = renderTree([nestedRoot()], ["t-mol-root"])
    expect(ids(container, "[data-step-header]")).toEqual(["t-mol-s1", "t-mol-s2"])
    expect(
      container.querySelector('[data-step-header][data-item-id="t-mol-s1"]')?.textContent,
    ).toContain("Step 1: bob prepares")
    // The root's hexagon alone: steps carry none.
    expect(container.querySelectorAll("svg.lucide-hexagon")).toHaveLength(1)
    // The loose task's phase comes first; a step's children are not phased.
    const order = ids(container, "[data-item-id]")
    expect(order.indexOf("t-mol-s3")).toBeLessThan(order.indexOf("t-mol-s1"))
    expect(
      Array.from(container.querySelectorAll("span")).filter((s) =>
        /^Phase \d+$/.test(s.textContent ?? ""),
      ),
    ).toHaveLength(1)
  })

  test("an expanded header lists its children in pour order; a collapsed one lists none", () => {
    const { container } = renderTree([nestedRoot()], ["t-mol-root", "t-mol-s1"])
    const order = ids(container, "[data-item-id]")
    const s1 = order.indexOf("t-mol-s1")
    expect(order.slice(s1, s1 + 4)).toEqual(["t-mol-s1", "t-mol-c1a", "t-mol-c1b", "t-mol-c1c"])
    expect(order.indexOf("t-mol-s2")).toBe(s1 + 4)
    expect(order).not.toContain("t-mol-c2a")
  })

  test("a step epic with no children shows its header and no rows", () => {
    const root = nestedRoot()
    root.childEpics = [epic("t-mol-s4", { title: "Step 4: nothing", parentId: "t-mol-root" })]
    const { container } = renderTree([root], ["t-mol-root", "t-mol-s4"])
    expect(ids(container, "[data-step-header]")).toEqual(["t-mol-s4"])
    const order = ids(container, "[data-item-id]")
    expect(order[order.length - 1]).toBe("t-mol-s4")
  })
})

// A flat molecule renders exactly as before this change: golden captured on
// origin/main (UPDATE_GOLDEN=1 rewrites it; never in CI).
describe("a flat molecule is unchanged (beadbox-e04o.1)", () => {
  test("a 3-task chain renders byte-identical to the pre-change golden", () => {
    const flat = epic("t-mol-flat", {
      title: "Flat molecule",
      type: "molecule",
      children: [
        task("t-mol-f1", { title: "First" }),
        task("t-mol-f2", {
          title: "Second",
          blockedBy: [{ id: "t-mol-f1", title: "First" }] as Bead["blockedBy"],
        }),
        task("t-mol-f3", {
          title: "Third",
          status: "closed",
          blockedBy: [{ id: "t-mol-f2", title: "Second" }] as Bead["blockedBy"],
        }),
      ],
    })
    const { container } = renderTree([flat], ["t-mol-flat"])
    if (process.env.UPDATE_GOLDEN === "1") {
      const golden = join(import.meta.dir, "__golden__", "molecule-flat-tree.ts")
      const head = readFileSync(golden, "utf-8").split("export const")[0]
      writeFileSync(
        golden,
        `${head}export const MOLECULE_FLAT_TREE_HTML =\n  ${JSON.stringify(container.innerHTML)}\n`,
      )
    }
    expect(container.innerHTML).toBe(MOLECULE_FLAT_TREE_HTML)
  })
})

// beadbox-e04o.2: counts per step, open unless finished, roots-only count.
describe("step counts and the open-unless-finished rule (beadbox-e04o.2)", () => {
  const stepWith = (id: string, statuses: string[]) =>
    epic(id, { parentId: "t-mol-root", children: statuses.map((st, i) => task(`${id}-c${i}`, { status: st as Bead["status"] })) })

  test("finished means children and every one closed; 0/0 is not finished", () => {
    expect(isStepFinished(stepWith("a", ["closed", "closed"]))).toBe(true)
    expect(isStepFinished(stepWith("b", ["closed", "open"]))).toBe(false)
    expect(isStepFinished(stepWith("c", []))).toBe(false)
    expect(stepCount(stepWith("d", ["closed", "blocked", "deferred"]))).toEqual({ closed: 1, total: 3 })
  })

  test("first sight opens an unfinished step, never a finished one", () => {
    const r = stepExpansionChanges([stepWith("open-me", ["open"]), stepWith("done", ["closed"]), stepWith("empty", [])], {})
    expect(r.open.sort()).toEqual(["empty", "open-me"])
    expect(r.close).toEqual([])
    expect(r.seen).toEqual({ "open-me": false, done: true, empty: false })
  })

  test("a step that turns finished collapses once; a user's toggle is left alone after", () => {
    const seen = { s: false }
    const turned = stepExpansionChanges([stepWith("s", ["closed"])], seen)
    expect(turned).toEqual({ open: [], close: ["s"], seen: { s: true } })
    // Seen finished already: nothing to change, whatever the user did since.
    expect(stepExpansionChanges([stepWith("s", ["closed"])], turned.seen)).toEqual({ open: [], close: [], seen: { s: true } })
    // Reopened (a child reopened): not forced open again.
    expect(stepExpansionChanges([stepWith("s", ["open"])], turned.seen)).toEqual({ open: [], close: [], seen: { s: false } })
  })

  test("the molecules section counts roots only, even if a step reached the top-level list", () => {
    const root = nestedRoot()
    const topLevel = [root, ...(root.childEpics ?? [])]
    expect(topLevel.filter((e) => isMoleculePresentation(e))).toHaveLength(1)
  })
})
