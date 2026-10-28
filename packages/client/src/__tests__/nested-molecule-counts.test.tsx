// beadbox-e04o.2: each step header of a nested molecule shows closed/total of
// that step's own children (bd list --parent <step>); an empty step is 0/0.
// Imports only the tree, so it is red on a tree without counts, not a load error.

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"

import { EpicTree } from "../components/epic-tree"
import type { Bead, Epic } from "../lib/types"

afterEach(cleanup)

const AT = new Date("2026-10-28T00:00:00Z")
const task = (id: string, status: string): Bead =>
  ({ id, title: id, type: "task", status, priority: "medium", labels: [], blockedBy: [], createdAt: AT, updatedAt: AT }) as unknown as Bead
const epic = (id: string, over: Partial<Epic> = {}): Epic =>
  ({
    id, title: id, description: "", status: "open", priority: "medium", type: "epic", assignee: "", labels: [],
    createdAt: AT, updatedAt: AT, comments: [], children: [], childEpics: [], commentCount: 0, ...over,
  }) as unknown as Epic

describe("step header counts (beadbox-e04o.2)", () => {
  test("a header shows closed/total of its own children; an empty step is 0/0", () => {
    const root = epic("t-mol-root", {
      type: "molecule",
      childEpics: [
        epic("t-mol-a", { parentId: "t-mol-root", children: [task("a1", "closed"), task("a2", "open"), task("a3", "in_progress")] }),
        epic("t-mol-z", { parentId: "t-mol-root" }),
      ],
    })
    const { container } = render(
      <EpicTree epics={[root]} expandedEpics={new Set(["t-mol-root"])} onToggleEpic={mock(() => {})} onBeadClick={mock(() => {})} />,
    )
    const counts = Array.from(container.querySelectorAll("[data-step-header]")).map((h) => [
      h.getAttribute("data-item-id"),
      h.querySelector("[data-step-count]")?.textContent,
    ])
    expect(counts).toEqual([
      ["t-mol-a", "1/3"],
      ["t-mol-z", "0/0"],
    ])
  })
})
