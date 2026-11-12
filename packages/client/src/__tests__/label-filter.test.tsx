// beadbox-ymx (GH #70): Filter the bead list by label.
// Covers predicate matching (empty = all, non-empty = ANY selected label,
// unlabelled exclusion), composition with status/type/priority/assignee/search,
// ancestor preservation across epics/subtasks/child-epics, FilterBar UI, and
// workspace-switch reset.

import { GlobalRegistrator } from "@happy-dom/global-registrator"

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register()
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act, cleanup, render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { FilterBar } from "../components/filter-bar"
import { usePreferences } from "../hooks/use-preferences"
import {
  collectAllBeadsFromEpics,
  extractLabels,
  filterEpics,
  matchesBead,
} from "../lib/epic-tree-utils"
import {
  getFiltersPreference,
  resetLabelFilterPreference,
  setFiltersPreference,
} from "../lib/local-storage"
import {
  type Bead,
  DEFAULT_STATUSES,
  type Epic,
  type Filters,
  labelFilterNarrows,
} from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function makeBead(id: string, over: Partial<Bead> = {}): Bead {
  return {
    id,
    type: "task",
    title: `Title ${id}`,
    description: "",
    status: "open",
    priority: "medium",
    assignee: "alice",
    comments: [],
    ...over,
  }
}

function makeEpic(id: string, over: Partial<Epic> = {}): Epic {
  return {
    ...makeBead(id, { type: "epic", title: `Epic ${id}` }),
    children: [],
    childEpics: [],
    ...over,
  }
}

function baseFilters(over: Partial<Filters> = {}): Filters {
  return {
    status: [...DEFAULT_STATUSES],
    assignee: "all",
    priority: [],
    labels: [],
    search: "",
    showMessages: false,
    showWaves: false,
    hasSpec: false,
    hasDeadline: false,
    rig: "all",
    grouped: false,
    ...over,
  }
}

function syntheticWorkspaceTree(): Epic[] {
  const unlabelledEmpty = makeBead("b-none", { title: "No labels empty", labels: [] })
  const unlabelledUndef = makeBead("b-undef", { title: "No labels undefined", labels: undefined })
  const oneFrontend = makeBead("b-fe", { title: "Frontend button", labels: ["frontend"] })
  const twoLabels = makeBead("b-fe-urg", {
    title: "Urgent frontend bug",
    type: "bug",
    status: "in_progress",
    priority: "critical",
    assignee: "bob",
    labels: ["frontend", "urgent"],
  })
  const oneBackend = makeBead("b-be", { title: "Backend query", labels: ["backend"] })

  const standalone = makeEpic("_standalone", {
    title: "Standalone",
    children: [unlabelledEmpty, unlabelledUndef, oneFrontend, twoLabels, oneBackend],
  })

  const nestedMatch = makeBead("b-nested-match", {
    title: "Deep nested leaf",
    labels: ["deep-tag"],
  })
  const nestedSibling = makeBead("b-nested-sibling", {
    title: "Unlabelled sibling leaf",
    labels: [],
  })
  const parentTask = makeBead("b-parent-task", {
    title: "Parent task without labels",
    labels: [],
    children: [nestedMatch, nestedSibling],
  })
  const epicOne = makeEpic("epic-1", {
    title: "Epic One",
    labels: [],
    children: [parentTask, makeBead("b-epic1-other", { labels: ["other"] })],
  })

  const epicUnmatched = makeEpic("epic-2", {
    title: "Unmatched Epic",
    labels: [],
    children: [makeBead("b-epic2-child", { labels: [] })],
  })

  const milestoneLeaf = makeBead("b-ms-leaf", {
    title: "Milestone leaf",
    labels: ["milestone-tag"],
  })
  const childEpic = makeEpic("child-epic-1", {
    title: "Child Epic",
    labels: [],
    children: [milestoneLeaf],
  })
  const milestone = makeEpic("ms-1", {
    type: "milestone",
    title: "Milestone One",
    labels: [],
    childEpics: [childEpic],
  })

  return [standalone, epicOne, epicUnmatched, milestone]
}

describe("labelFilterNarrows", () => {
  test("empty selection does not narrow; any selected label narrows", () => {
    expect(labelFilterNarrows([])).toBe(false)
    expect(labelFilterNarrows(["frontend"])).toBe(true)
    expect(labelFilterNarrows(["frontend", "backend"])).toBe(true)
  })
})

describe("matchesBead label predicate", () => {
  test("empty labels=[] admits unlabelled, undefined-labels, single-label, and multi-label beads", () => {
    const f = baseFilters({ labels: [] })
    expect(matchesBead(makeBead("1", { labels: undefined }), f)).toBe(true)
    expect(matchesBead(makeBead("2", { labels: [] }), f)).toBe(true)
    expect(matchesBead(makeBead("3", { labels: ["frontend"] }), f)).toBe(true)
    expect(matchesBead(makeBead("4", { labels: ["frontend", "urgent"] }), f)).toBe(true)
  })

  test("single selected label matches beads carrying it (1 or 2 labels) and excludes others", () => {
    const f = baseFilters({ labels: ["frontend"] })
    expect(matchesBead(makeBead("1", { labels: undefined }), f)).toBe(false)
    expect(matchesBead(makeBead("2", { labels: [] }), f)).toBe(false)
    expect(matchesBead(makeBead("3", { labels: ["frontend"] }), f)).toBe(true)
    expect(matchesBead(makeBead("4", { labels: ["frontend", "urgent"] }), f)).toBe(true)
    expect(matchesBead(makeBead("5", { labels: ["backend"] }), f)).toBe(false)
  })

  test("multiple selected labels match beads having ANY selected label", () => {
    const f = baseFilters({ labels: ["backend", "urgent"] })
    expect(matchesBead(makeBead("1", { labels: ["backend"] }), f)).toBe(true)
    expect(matchesBead(makeBead("2", { labels: ["frontend", "urgent"] }), f)).toBe(true)
    expect(matchesBead(makeBead("3", { labels: ["frontend"] }), f)).toBe(false)
    expect(matchesBead(makeBead("4", { labels: [] }), f)).toBe(false)
  })

  test("selecting every label in the workspace still excludes unlabelled beads", () => {
    const tree = syntheticWorkspaceTree()
    const allWorkspaceLabels = extractLabels(tree)
    expect(allWorkspaceLabels).toEqual([
      "backend",
      "deep-tag",
      "frontend",
      "milestone-tag",
      "other",
      "urgent",
    ])
    const f = baseFilters({ labels: allWorkspaceLabels })
    expect(matchesBead(makeBead("none", { labels: [] }), f)).toBe(false)
    expect(matchesBead(makeBead("undef", { labels: undefined }), f)).toBe(false)
    expect(matchesBead(makeBead("fe", { labels: ["frontend"] }), f)).toBe(true)
  })

  test("composes with status, type, priority, assignee, and search", () => {
    const target = makeBead("bb-42", {
      title: "Fix login modal",
      status: "in_progress",
      type: "bug",
      priority: "critical",
      assignee: "bob",
      labels: ["frontend", "auth"],
    })
    const matchingAll = baseFilters({
      labels: ["auth"],
      status: ["in_progress"],
      type: "bug",
      priority: ["critical"],
      assignee: "bob",
      search: "login",
    })
    expect(matchesBead(target, matchingAll)).toBe(true)

    // Failing any composed filter excludes the bead even when label matches
    expect(matchesBead(target, { ...matchingAll, status: ["open"] })).toBe(false)
    expect(matchesBead(target, { ...matchingAll, type: "task" })).toBe(false)
    expect(matchesBead(target, { ...matchingAll, priority: ["low"] })).toBe(false)
    expect(matchesBead(target, { ...matchingAll, assignee: "alice" })).toBe(false)
    expect(matchesBead(target, { ...matchingAll, search: "signup" })).toBe(false)
    // Failing label excludes the bead even when status/type/priority/assignee/search all match
    expect(matchesBead(target, { ...matchingAll, labels: ["backend"] })).toBe(false)
  })
})

describe("filterEpics label filtering and ancestor preservation", () => {
  test("preserves unlabelled epic and parent task as context when a nested subtask matches", () => {
    const tree = syntheticWorkspaceTree()
    const filtered = filterEpics(tree, baseFilters({ labels: ["deep-tag"] }))

    // _standalone, epic-2, and ms-1 have no "deep-tag" descendants and must drop out
    expect(filtered.map((e) => e.id)).toEqual(["epic-1"])
    expect(filtered[0].children?.map((b) => b.id)).toEqual(["b-parent-task"])
    expect(filtered[0].children?.[0].children?.map((b) => b.id)).toEqual(["b-nested-match"])
  })

  test("preserves milestone and child epic as context when a child-epic leaf matches", () => {
    const tree = syntheticWorkspaceTree()
    const filtered = filterEpics(tree, baseFilters({ labels: ["milestone-tag"] }))

    expect(filtered.map((e) => e.id)).toEqual(["ms-1"])
    expect(filtered[0].childEpics?.map((e) => e.id)).toEqual(["child-epic-1"])
    expect(filtered[0].childEpics?.[0].children?.map((b) => b.id)).toEqual(["b-ms-leaf"])
  })

  test("composes label ANY matching with status and search across the tree", () => {
    const tree = syntheticWorkspaceTree()
    // ANY of ["frontend", "deep-tag"] -> b-fe, b-fe-urg (in _standalone), and b-nested-match (in epic-1)
    const anyFiltered = filterEpics(tree, baseFilters({ labels: ["frontend", "deep-tag"] }))
    const visibleIds = collectAllBeadsFromEpics(anyFiltered)
      .map((b) => b.id)
      .filter((id) => id !== "_standalone")
      .sort()
    expect(visibleIds).toEqual(["b-fe", "b-fe-urg", "b-nested-match", "b-parent-task", "epic-1"])

    // Compose with status=["in_progress"] and search="urgent" -> only b-fe-urg remains
    const narrowed = filterEpics(
      tree,
      baseFilters({
        labels: ["frontend", "deep-tag"],
        status: ["in_progress"],
        search: "urgent",
      }),
    )
    expect(narrowed.map((e) => e.id)).toEqual(["_standalone"])
    expect(narrowed[0].children?.map((b) => b.id)).toEqual(["b-fe-urg"])
  })
})

describe("label filter persistence and workspace switch reset", () => {
  const wsA = { id: "11111111-1111-4111-8111-111111111111" }
  const wsB = { id: "22222222-2222-4222-8222-222222222222" }

  test("resetLabelFilterPreference clears stored labels while keeping other filters", () => {
    setFiltersPreference(
      baseFilters({ status: ["open"], assignee: "bob", priority: ["high"], labels: ["frontend"] }),
    )
    resetLabelFilterPreference()
    const after = getFiltersPreference()
    expect(after.labels).toEqual([])
    expect(after.status).toEqual(["open"])
    expect(after.assignee).toBe("bob")
    expect(after.priority).toEqual(["high"])
  })

  test("persists selected labels across remount on the same workspace", () => {
    setWorkspaceCookie(wsA.id)
    const first = renderHook(() => usePreferences([wsA, wsB]))
    act(() => {
      first.result.current.setFilters(baseFilters({ labels: ["frontend", "urgent"] }))
    })
    expect(first.result.current.filters.labels).toEqual(["frontend", "urgent"])
    first.unmount()

    // Re-writing the same workspace cookie on reload must not wipe labels
    setWorkspaceCookie(wsA.id)
    const second = renderHook(() => usePreferences([wsA, wsB]))
    expect(second.result.current.filters.labels).toEqual(["frontend", "urgent"])
  })

  test("resets filters.labels live on workspace switch while keeping status/priority/assignee", () => {
    setWorkspaceCookie(wsA.id)
    const { result } = renderHook(() => usePreferences([wsA, wsB]))
    act(() => {
      result.current.setFilters(
        baseFilters({
          status: ["open", "in_progress"],
          priority: ["critical"],
          assignee: "bob",
          labels: ["frontend"],
        }),
      )
    })
    expect(result.current.filters.labels).toEqual(["frontend"])

    act(() => {
      setWorkspaceCookie(wsB.id)
    })

    expect(result.current.filters.labels).toEqual([])
    expect(result.current.filters.status).toEqual(["open", "in_progress"])
    expect(result.current.filters.priority).toEqual(["critical"])
    expect(result.current.filters.assignee).toBe("bob")
    expect(getFiltersPreference().labels).toEqual([])
  })

  test("resets filters.labels when switching from a cookie-unset fallback workspace", () => {
    // No cookie set initially: active workspace falls back to initialWorkspaces[0] (wsA)
    const { result } = renderHook(() => usePreferences([wsA, wsB]))
    act(() => {
      result.current.setFilters(baseFilters({ labels: ["alpha-only"] }))
    })
    expect(result.current.filters.labels).toEqual(["alpha-only"])

    act(() => {
      setWorkspaceCookie(wsB.id)
    })

    expect(result.current.filters.labels).toEqual([])
    expect(getFiltersPreference().labels).toEqual([])
  })

  test("resets persisted labels when switching or clearing workspace while unmounted", () => {
    setWorkspaceCookie(wsA.id)
    setFiltersPreference(baseFilters({ status: ["open"], labels: ["ws-a-label"] }))

    // Switch to wsB from /workspaces while HomePage/usePreferences is unmounted
    setWorkspaceCookie(wsB.id)
    expect(getFiltersPreference().labels).toEqual([])
    expect(getFiltersPreference().status).toEqual(["open"])

    // Select a label on wsB, then unregister wsB (clearWorkspaceCookie)
    setFiltersPreference(baseFilters({ labels: ["ws-b-label"] }))
    clearWorkspaceCookie()
    expect(getFiltersPreference().labels).toEqual([])
  })
})

function FilterBarHarness({
  initial,
  availableLabels,
  seen,
}: {
  initial: Filters
  availableLabels: string[]
  seen: Filters[]
}) {
  const [filters, setFilters] = useState(initial)
  return (
    <FilterBar
      filters={filters}
      onFiltersChange={(next) => {
        seen.push(next)
        setFilters(next)
      }}
      assignees={["alice", "bob"]}
      availableLabels={availableLabels}
      availableStatuses={["open", "in_progress", "closed"]}
    />
  )
}

const labelTrigger = () => screen.getAllByRole("button", { name: "Label filter" })[0]
const checkboxNames = () => screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))

describe("FilterBar Label filter control (beadbox-ymx)", () => {
  test("lists sorted workspace labels beside existing filters with All Labels default", async () => {
    const user = userEvent.setup()
    render(
      <FilterBarHarness
        initial={baseFilters()}
        availableLabels={["urgent", "backend", "frontend"]}
        seen={[]}
      />,
    )
    expect(labelTrigger().textContent).toContain("All Labels")
    await user.click(labelTrigger())
    expect(checkboxNames()).toEqual(["All Labels", "backend", "frontend", "urgent"])
  })

  test("selecting one or multiple labels updates Filters.labels and summarizes the trigger", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(
      <FilterBarHarness
        initial={baseFilters()}
        availableLabels={["backend", "frontend", "urgent"]}
        seen={seen}
      />,
    )
    await user.click(labelTrigger())
    await user.click(screen.getByRole("checkbox", { name: "frontend" }).closest("button")!)
    expect(seen.at(-1)?.labels).toEqual(["frontend"])
    expect(labelTrigger().textContent).toContain("frontend")

    await user.click(screen.getByRole("checkbox", { name: "urgent" }).closest("button")!)
    expect(seen.at(-1)?.labels).toEqual(["frontend", "urgent"])
    expect(labelTrigger().textContent).toContain("2 labels")

    // Selecting all available labels still reads as a narrowing label count (unlike Priority)
    await user.click(screen.getByRole("checkbox", { name: "backend" }).closest("button")!)
    expect(seen.at(-1)?.labels).toEqual(["frontend", "urgent", "backend"])
    expect(labelTrigger().textContent).toContain("3 labels")
  })

  test("clicking All Labels or unchecking the last selected label clears back to []", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(
      <FilterBarHarness
        initial={baseFilters({ labels: ["frontend", "urgent"] })}
        availableLabels={["backend", "frontend", "urgent"]}
        seen={seen}
      />,
    )
    await user.click(labelTrigger())
    await user.click(screen.getByRole("checkbox", { name: "All Labels" }).closest("button")!)
    expect(seen.at(-1)?.labels).toEqual([])
    expect(labelTrigger().textContent).toContain("All Labels")

    // Select one label and uncheck it directly -> also returns to [] ("All Labels")
    await user.click(screen.getByRole("checkbox", { name: "backend" }).closest("button")!)
    expect(seen.at(-1)?.labels).toEqual(["backend"])
    await user.click(screen.getByRole("checkbox", { name: "backend" }).closest("button")!)
    expect(seen.at(-1)?.labels).toEqual([])
    expect(labelTrigger().textContent).toContain("All Labels")
  })

  test("keeps a selected label visible in options even if removed from workspace beads", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(
      <FilterBarHarness
        initial={baseFilters({ labels: ["removed-tag"] })}
        availableLabels={["frontend"]}
        seen={seen}
      />,
    )
    expect(labelTrigger().textContent).toContain("removed-tag")
    await user.click(labelTrigger())
    expect(checkboxNames()).toEqual(["All Labels", "frontend", "removed-tag"])
    await user.click(screen.getByRole("checkbox", { name: "removed-tag" }).closest("button")!)
    expect(seen.at(-1)?.labels).toEqual([])
  })

  test("supports keyboard navigation: Enter opens, arrows move, Space toggles, Escape closes", async () => {
    const user = userEvent.setup()
    const seen: Filters[] = []
    render(
      <FilterBarHarness
        initial={baseFilters()}
        availableLabels={["alpha", "beta", "gamma"]}
        seen={seen}
      />,
    )
    labelTrigger().focus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("checkbox", { name: "alpha" })).toBeTruthy()
    // Focus starts on "All Labels"; ArrowDown twice -> "beta"
    await user.keyboard("{ArrowDown}{ArrowDown}")
    expect(document.activeElement?.textContent).toBe("beta")
    await user.keyboard(" ")
    expect(seen.at(-1)?.labels).toEqual(["beta"])
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("checkbox", { name: "alpha" })).toBeNull()
  })

  test("counts active label filter in the mobile filter badge", () => {
    const prevWidth = window.innerWidth
    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: 375,
      })
      const { container, rerender } = render(
        <FilterBar
          filters={baseFilters({ status: [] })}
          onFiltersChange={() => {}}
          assignees={[]}
          availableLabels={["frontend"]}
          availableStatuses={["open", "in_progress", "closed"]}
        />,
      )
      expect(container.querySelector("span.rounded-full")).toBeNull()

      rerender(
        <FilterBar
          filters={baseFilters({ status: [], labels: ["frontend"] })}
          onFiltersChange={() => {}}
          assignees={[]}
          availableLabels={["frontend"]}
          availableStatuses={["open", "in_progress", "closed"]}
        />,
      )
      expect(container.querySelector("span.rounded-full")?.textContent).toBe("1")
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: prevWidth,
      })
    }
  })
})
