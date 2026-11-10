// beadbox-005: a live refresh must not remount the rows of an expanded epic.
//
// On a busy workspace every change refetches the tree and re-renders it.
// Row keys that carried the row's INDEX made a status change that moves one
// row (or a reordered epic group) change the key of every row after it, so
// React unmounted and remounted all of them: every remount builds the row
// again, including its matchMedia listeners (useViewport in BeadRow and
// CopyableId). On a large board one refresh churned thousands of listeners
// and ~150 MB, which WebKit's JS heap does not give back.
//
// The test renders two expanded epics, then refreshes them the way a refetch
// does (new objects; a child moved; the groups reordered) and asserts that no
// row that still exists is remounted: the same DOM node stays, and no new
// matchMedia registration happens.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"

import { EpicTree } from "../components/epic-tree"
import type { Bead, Epic } from "../lib/types"

afterEach(cleanup)

let matchMediaCalls = 0
let realMatchMedia: typeof window.matchMedia
beforeEach(() => {
  realMatchMedia = window.matchMedia
  matchMediaCalls = 0
  const base =
    realMatchMedia?.bind(window) ??
    ((q: string) =>
      ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList)
  window.matchMedia = ((q: string) => {
    matchMediaCalls++
    return base(q)
  }) as typeof window.matchMedia
})
afterEach(() => {
  window.matchMedia = realMatchMedia
})

const CHILDREN = 20

function bead(id: string, parent: string): Bead {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "open",
    priority: 2,
    type: "task",
    assignee: "",
    labels: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    comments: [],
    commentCount: 0,
    parentId: parent,
  } as unknown as Bead
}

function epic(id: string, childIds: string[]): Epic {
  return {
    id,
    title: `Epic ${id}`,
    description: "",
    status: "open",
    priority: 1,
    type: "epic",
    assignee: "",
    labels: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    comments: [],
    children: childIds.map((c) => bead(c, id)),
    childEpics: [],
    commentCount: 0,
  } as unknown as Epic
}

const ids = (e: string) => Array.from({ length: CHILDREN }, (_, i) => `${e}.${i + 1}`)

function tree(props: { epics: Epic[] }) {
  return (
    <EpicTree
      epics={props.epics}
      expandedEpics={new Set(["bb-a", "bb-b"])}
      onToggleEpic={mock(() => {})}
      onBeadClick={mock(() => {})}
    />
  )
}

const rowNode = (id: string) => document.querySelector(`[data-item-id="${id}"]`)

function snapshotRows(all: string[]) {
  return new Map(all.map((id) => [id, rowNode(id)]))
}

function remounted(before: Map<string, Element | null>): string[] {
  return [...before].filter(([id, node]) => node && rowNode(id) !== node).map(([id]) => id)
}

describe("live refresh of an expanded epic (beadbox-005)", () => {
  test("renders every row of both expanded epics", () => {
    render(tree({ epics: [epic("bb-a", ids("bb-a")), epic("bb-b", ids("bb-b"))] }))
    for (const id of [...ids("bb-a"), ...ids("bb-b")]) expect(rowNode(id)).toBeTruthy()
  })

  test("a refetch with the same data remounts nothing", () => {
    const { rerender } = render(tree({ epics: [epic("bb-a", ids("bb-a")), epic("bb-b", ids("bb-b"))] }))
    const before = snapshotRows([...ids("bb-a"), ...ids("bb-b")])
    const calls = matchMediaCalls
    rerender(tree({ epics: [epic("bb-a", ids("bb-a")), epic("bb-b", ids("bb-b"))] }))
    expect(remounted(before)).toEqual([])
    expect(matchMediaCalls - calls).toBe(0)
  })

  test("one child moving within its epic remounts no other row", () => {
    const { rerender } = render(tree({ epics: [epic("bb-a", ids("bb-a")), epic("bb-b", ids("bb-b"))] }))
    const before = snapshotRows([...ids("bb-a"), ...ids("bb-b")])
    const calls = matchMediaCalls
    // bb-a.1 changes status and sorts to the end of its group.
    const moved = [...ids("bb-a").slice(1), "bb-a.1"]
    rerender(tree({ epics: [epic("bb-a", moved), epic("bb-b", ids("bb-b"))] }))
    expect(remounted(before).filter((id) => id !== "bb-a.1")).toEqual([])
    // At most the moved row itself may mount again (3 matchMedia per useViewport, 2 per row).
    expect(matchMediaCalls - calls).toBeLessThanOrEqual(6)
  })

  test("epic groups swapping order remount none of their rows", () => {
    const { rerender } = render(tree({ epics: [epic("bb-a", ids("bb-a")), epic("bb-b", ids("bb-b"))] }))
    const before = snapshotRows([...ids("bb-a"), ...ids("bb-b")])
    const calls = matchMediaCalls
    rerender(tree({ epics: [epic("bb-b", ids("bb-b")), epic("bb-a", ids("bb-a"))] }))
    expect(remounted(before)).toEqual([])
    expect(matchMediaCalls - calls).toBe(0)
  })

  test("the same bead in two groups, or twice in one list, renders with no duplicate-key warning", () => {
    const errors: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    }
    try {
      // bb-x.1 is listed under both epics, and twice under bb-b.
      const a = epic("bb-a", [...ids("bb-a"), "bb-x.1"])
      const b = epic("bb-b", ["bb-x.1", ...ids("bb-b"), "bb-x.1"])
      const { rerender } = render(tree({ epics: [a, b] }))
      rerender(tree({ epics: [epic("bb-b", ["bb-x.1", ...ids("bb-b"), "bb-x.1"]), epic("bb-a", [...ids("bb-a"), "bb-x.1"])] }))
      expect(document.querySelectorAll('[data-item-id="bb-x.1"]').length).toBe(3)
    } finally {
      console.error = realError
    }
    expect(errors.filter((e) => /same key|unique "key"/i.test(e))).toEqual([])
  })
})
