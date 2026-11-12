import { describe, expect, test } from "bun:test"
import { extractLabels, filterEpics, matchesBead } from "../lib/epic-tree-utils"
import { getFiltersPreference } from "../lib/local-storage"
import type { Bead, Epic, Filters } from "../lib/types"

const bead = (id: string, extra: Partial<Bead> = {}): Bead =>
  ({ id, title: id, type: "task", status: "open", priority: "medium", ...extra }) as Bead
const filters = (extra: Partial<Filters> = {}): Filters => ({
  ...getFiltersPreference(),
  status: ["open", "closed"],
  ...extra,
})

describe("label filter (GitHub #70)", () => {
  test("matches ANY selected label exactly, excluding unlabeled and other labels", () => {
    const f = filters({ labels: ["frontend", "urgent"] })
    expect(matchesBead(bead("one", { labels: ["frontend"] }), f)).toBe(true)
    expect(matchesBead(bead("two", { labels: ["backend", "urgent"] }), f)).toBe(true)
    for (const labels of [undefined, [], ["backend"], ["Frontend"], ["frontend-extra"]]) {
      expect(matchesBead(bead("miss", { labels }), f)).toBe(false)
    }
  })

  test("clearing labels includes unlabeled beads and all labels", () => {
    const narrowed = filters({ labels: ["urgent"] })
    expect(matchesBead(bead("plain"), narrowed)).toBe(false)
    for (const labels of [undefined, [], ["backend"], ["urgent"]]) {
      expect(matchesBead(bead("any", { labels }), { ...narrowed, labels: [] })).toBe(true)
    }
  })

  test("composes labels with status, type, priority, assignee and search", () => {
    const f = filters({
      labels: ["frontend"],
      status: ["open"],
      type: "task",
      priority: ["medium"],
      assignee: "eng8",
      search: "needle",
    })
    const hit = bead("needle", { labels: ["frontend"], assignee: "eng8" })
    expect(matchesBead(hit, f)).toBe(true)
    for (const extra of [
      { labels: ["backend"] },
      { status: "closed" },
      { type: "bug" },
      { priority: "high" },
      { assignee: "eng6" },
      { id: "miss", title: "miss" },
    ]) {
      expect(matchesBead({ ...hit, ...extra } as Bead, f)).toBe(false)
    }
  })

  test("retains nested epic and bead ancestors, pruning nonmatching siblings", () => {
    const leaf = bead("leaf", { labels: ["urgent"] })
    const root = {
      ...bead("root"),
      type: "epic",
      children: [],
      childEpics: [
        {
          ...bead("epic"),
          type: "epic",
          children: [bead("parent", { children: [leaf, bead("sibling")] })],
        },
      ],
    } as Epic
    const result = filterEpics([root], filters({ labels: ["urgent"] }))
    expect(result).toHaveLength(1)
    expect(result[0].childEpics?.[0].children?.[0].children?.map((b) => b.id)).toEqual(["leaf"])
    expect(filterEpics([root], filters({ labels: ["absent"] }))).toEqual([])
    expect(extractLabels([root])).toEqual(["urgent"])
  })
})
