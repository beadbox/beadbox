// Chart view (beadbox-eic): rendering, shared filters, collapse, bar styles,
// dependency drawing, the degraded notice, and opening a bead on Beads.

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"

import { StartupGate } from "../components/startup-gate"
import { getSelectedBead, setFiltersPreference, setSelectedBead } from "../lib/local-storage"
import { queryClient } from "../lib/query-client"
import { _setRpc, type RemoteApi } from "../lib/rpc"
import type { Bead, Epic, Filters, Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

const ws: Workspace = {
  id: "3f1b8a24-0000-4000-8000-0000000c4a47",
  name: "chart-ws",
  path: "/tmp/chart-ws",
  databasePath: "/tmp/chart-ws/.beads",
  mode: "embedded",
}

const day = (n: number) => new Date(Date.now() - (10 - n) * 86_400_000)

function bead(id: string, extra: Partial<Bead> = {}): Bead {
  return {
    id,
    type: "task",
    title: `Title ${id}`,
    description: "",
    status: "open",
    priority: "medium",
    assignee: "",
    labels: [],
    comments: [],
    createdAt: day(0),
    updatedAt: day(0),
    ...extra,
  }
}

function tree(): Epic[] {
  return [
    {
      ...bead("E1", { type: "epic", title: "Epic one", status: "in_progress" }),
      children: [
        bead("a", { assignee: "alice", status: "in_progress", metadata: { started_at: day(2).toISOString() } }),
        bead("b", { assignee: "bob" }),
        bead("c", { assignee: "bob", status: "closed", closedAt: day(5) }),
        bead("x", { assignee: "bob", status: "blocked" }),
      ],
      childEpics: [],
    },
    {
      ...bead("E2", { type: "epic", title: "Epic two" }),
      children: [bead("d", { assignee: "bob" })],
      childEpics: [],
    },
  ]
}

type BlocksPayload = { blockedBy: Record<string, string[]>; degraded?: { reason: "error"; message: string } }
let blocksAnswer: BlocksPayload = { blockedBy: { b: ["a"], d: ["a"] } }

const FILTERS: Filters = {
  status: ["open", "in_progress", "closed", "blocked", "deferred"],
  assignee: "all",
  priority: "all",
  showMessages: false,
  showWaves: false,
  hasSpec: false,
  hasDeadline: false,
  search: "",
  rig: "all",
  grouped: false,
}

let ChartView: typeof import("../components/chart-view").ChartView

beforeAll(async () => {
  installRpc()
  ChartView = (await import("../components/chart-view")).ChartView
})

function installRpc() {
  const benign = (): RemoteApi[keyof RemoteApi] =>
    new Proxy({}, { get: () => mock(() => Promise.resolve({ success: true, data: [], epics: [] })) }) as never
  const api = {
    health: {
      runStartupHealth: mock(() =>
        Promise.resolve({
          platform: "darwin",
          hasWorkspaces: true,
          workspaces: [{ ...ws, databasePath: `${ws.databasePath}/beads.db` }],
          activeWorkspaceId: ws.id,
          healthCheck: { ok: true as const },
          bdVersion: "1.2.2",
          bdPath: "/opt/homebrew/bin/bd",
        }),
      ),
    },
    epics: new Proxy(
      {
        incrementalRefresh: mock(() => Promise.resolve({ success: true as const, epics: tree() })),
        getBlocksDependencies: mock(() => Promise.resolve(blocksAnswer)),
      },
      {
        get: (t, k) => (k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve({ success: true, data: [] }))),
      },
    ),
    workspaces: new Proxy(
      { getWorkspaces: mock(() => Promise.resolve([ws])) },
      { get: (t, k) => (k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve())) },
    ),
    beads: new Proxy(
      {
        getAvailableStatuses: mock(() => Promise.resolve(["open", "in_progress", "closed", "blocked"])),
        getAvailableTypes: mock(() => Promise.resolve(["task", "epic"])),
      },
      {
        get: (t, k) => (k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve({ success: true }))),
      },
    ),
  }
  _setRpc(
    new Proxy(api, { get: (t, k) => (k in t ? t[k as keyof typeof t] : benign()) }) as unknown as RemoteApi,
  )
}

function mountChart() {
  const rootRoute = createRootRoute({
    component: () => (
      <StartupGate>
        <Outlet />
      </StartupGate>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>BEADS VIEW</p> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/chart", component: ChartView }),
    createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
  ])
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/chart"] }) })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

async function mounted() {
  setWorkspaceCookie(ws.id)
  mountChart()
  await waitFor(() => expect(screen.getAllByTestId("gantt-row-title").length).toBeGreaterThan(0), { timeout: 5_000 })
}

const titles = () => screen.queryAllByTestId("gantt-row-title").map((el) => el.getAttribute("title")?.split(":")[0])
const barFor = (id: string) => document.querySelector(`[data-testid="gantt-bar"][data-bead-id="${id}"]`)

afterEach(() => {
  cleanup()
  queryClient.clear()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
  sessionStorage.clear()
  setFiltersPreference(FILTERS)
  setSelectedBead(null)
  blocksAnswer = { blockedBy: { b: ["a"], d: ["a"] } }
})

describe("Chart view", () => {
  test("renders a section per epic with a row per bead", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    expect(screen.getAllByTestId("gantt-section").map((el) => el.textContent)).toEqual(["Epic one", "Epic two"])
    expect(titles()).toEqual(["a", "b", "c", "x", "d"])
  }, 20_000)

  test("uses the Beads view's saved filters", async () => {
    setFiltersPreference({ ...FILTERS, assignee: "alice" })
    await mounted()
    expect(titles()).toEqual(["a"])
  }, 20_000)

  test("collapsing a section hides its rows but keeps its summary bar", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const summaries = () => screen.getAllByTestId("gantt-summary-bar").length
    expect(summaries()).toBe(2)
    fireEvent.click(screen.getByRole("button", { name: /Epic one/ }))
    expect(titles()).toEqual(["d"])
    expect(summaries()).toBe(2)
  }, 20_000)

  test("draws hollow, blocked, solid and done bars", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    expect(barFor("a")?.getAttribute("data-style")).toBe("working")
    expect(barFor("b")?.getAttribute("data-style")).toBe("waiting hollow")
    expect(barFor("x")?.getAttribute("data-style")).toBe("blocked hollow")
    expect(barFor("x")?.getAttribute("class")).toContain("stroke-red-500")
    expect(barFor("c")?.getAttribute("data-style")).toBe("done")
  }, 20_000)

  test("an arrow inside a section, a marker naming the bead across sections", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    await waitFor(() => expect(screen.getAllByTestId("gantt-arrow").length).toBe(1), { timeout: 5_000 })
    const markers = screen.getAllByTestId("gantt-marker").map((el) => el.getAttribute("aria-label"))
    expect(markers).toContain("Blocked by a: Title a")
    expect(markers).toContain("Blocks d: Title d")
  }, 20_000)

  test("connectors end on the dependent's start edge, heading right, coloured by its style", async () => {
    // a (working) blocks b (dotted, not started) and c (closed, solid).
    blocksAnswer = { blockedBy: { b: ["a"], c: ["a"] } }
    setFiltersPreference(FILTERS)
    await mounted()
    await waitFor(() => expect(screen.getAllByTestId("gantt-arrow").length).toBe(2), { timeout: 5_000 })
    for (const [to, tone, marker] of [
      ["b", "stroke-foreground", "url(#gantt-arrow-strong)"],
      ["c", "stroke-muted-foreground", "url(#gantt-arrow)"],
    ] as const) {
      const path = document.querySelector(`[data-testid="gantt-arrow"][data-to="${to}"]`)!
      const points = path
        .getAttribute("d")!
        .split(/[ML]/)
        .filter(Boolean)
        .map((p) => p.trim().split(",").map(Number))
      const [last, beforeLast] = [points[points.length - 1], points[points.length - 2]]
      const bar = barFor(to)!
      const top = Number(bar.getAttribute("y"))
      const height = Number(bar.getAttribute("height"))
      expect(last[0]).toBeCloseTo(Number(bar.getAttribute("x")))
      expect(last[1]).toBeGreaterThan(top)
      expect(last[1]).toBeLessThan(top + height)
      expect(beforeLast[1]).toBe(last[1]) // horizontal...
      expect(beforeLast[0]).toBeLessThan(last[0]) // ...heading right into the start edge
      expect(path.getAttribute("class")).toContain(tone)
      expect(path.getAttribute("marker-end")).toBe(marker)
    }
  }, 20_000)

  test("a blocked chain renders in order, with a now line before the plan", async () => {
    // a is running; b (not started) waits for a; x (blocked) waits for b.
    blocksAnswer = { blockedBy: { b: ["a"], x: ["b"] } }
    setFiltersPreference(FILTERS)
    await mounted()
    await waitFor(() => expect(screen.getAllByTestId("gantt-arrow").length).toBe(2), { timeout: 5_000 })
    const span = (id: string) => {
      const bar = barFor(id)!
      const left = Number(bar.getAttribute("x"))
      return [left, left + Number(bar.getAttribute("width"))]
    }
    const [a, b, x] = [span("a"), span("b"), span("x")]
    expect(b[0]).toBeGreaterThanOrEqual(a[1] - 0.5)
    expect(x[0]).toBeGreaterThanOrEqual(b[1] - 0.5)
    const nowX = Number(screen.getByTestId("gantt-now").getAttribute("x1"))
    expect(nowX).toBeCloseTo(a[1], 0) // the running bar ends at now
    expect(b[0]).toBeGreaterThanOrEqual(nowX - 0.5) // the plan starts no earlier than now
  }, 20_000)

  test("the timeline scroller is the only scroll container and holds no titles (beadbox-aqn.1.2)", async () => {
    // A scrollbar spans the element that scrolls; with the titles outside the
    // scroller, the scrollbars run only along the bars.
    setFiltersPreference(FILTERS)
    await mounted()
    const frame = screen.getByTestId("gantt-frame")
    const scroller = screen.getByTestId("gantt-scroll")
    const titles = screen.getByTestId("gantt-titles")
    expect(frame.querySelectorAll(".overflow-auto")).toHaveLength(1)
    expect(frame.querySelector(".overflow-auto")).toBe(scroller)
    expect(scroller.contains(titles)).toBe(false)
    expect(titles.className).toContain("overflow-hidden")
    // The axis scrolls sideways with the bars and stays on top.
    const header = screen.getByTestId("gantt-header-row")
    expect(scroller.contains(header)).toBe(true)
    expect(header.className).toContain("sticky top-0")
    expect(frame.querySelector(".grid")).toBeNull()
  }, 20_000)

  test("the titles follow the scroller, focus scrolling flows back, and wheel over the titles scrolls it", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const scroller = screen.getByTestId("gantt-scroll")
    const titles = screen.getByTestId("gantt-titles")
    scroller.scrollTop = 56
    fireEvent.scroll(scroller)
    expect(titles.scrollTop).toBe(56)

    titles.scrollTop = 28 // e.g. keyboard focus moved to a title
    fireEvent.scroll(titles)
    expect(scroller.scrollTop).toBe(28)

    const calls: Array<{ left?: number; top?: number }> = []
    scroller.scrollBy = ((opts: ScrollToOptions) => calls.push(opts)) as typeof scroller.scrollBy
    fireEvent.wheel(titles, { deltaY: 40, deltaX: 0 })
    expect(calls).toEqual([{ left: 0, top: 40 }])
  }, 20_000)

  test("a marker shows its tooltip on keyboard focus and on hover, with no native <title>", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const marker = screen
      .getAllByTestId("gantt-marker")
      .find((el) => el.getAttribute("aria-label") === "Blocked by a: Title a")!
    expect(marker.getAttribute("tabindex")).toBe("0")
    expect(marker.querySelector("title")).toBeNull()
    expect(Number(marker.querySelector("circle")!.getAttribute("r"))).toBeGreaterThan(3.5) // hit area

    fireEvent.focus(marker)
    await waitFor(() => expect(screen.getAllByText("Blocked by a: Title a").length).toBeGreaterThan(0), {
      timeout: 2_000,
    })
    fireEvent.blur(marker)

    const other = screen.getAllByTestId("gantt-marker").find((el) => el.getAttribute("aria-label") === "Blocks d: Title d")!
    fireEvent.pointerMove(other, { pointerType: "mouse" })
    await waitFor(() => expect(screen.getAllByText("Blocks d: Title d").length).toBeGreaterThan(0), { timeout: 2_000 })
  }, 20_000)

  test("the legend explains every chart element with the chart's own styles", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const legend = screen.getByTestId("gantt-legend")
    const swatch = (key: string) => legend.querySelector(`[data-testid="legend-${key}"] svg > *`)!
    // Bars: same classes as the drawn bars of each style.
    expect(swatch("working").getAttribute("class")).toBe(barFor("a")!.getAttribute("class"))
    expect(swatch("planned").getAttribute("class")).toBe(barFor("b")!.getAttribute("class"))
    expect(swatch("planned").getAttribute("stroke-dasharray")).toBe(barFor("b")!.getAttribute("stroke-dasharray"))
    expect(swatch("blocked").getAttribute("class")).toBe(barFor("x")!.getAttribute("class"))
    expect(swatch("done").getAttribute("class")).toBe(barFor("c")!.getAttribute("class"))
    // Markers and the now line.
    const dot = (label: string) =>
      screen.getAllByTestId("gantt-marker").find((el) => el.getAttribute("aria-label") === label)!.querySelector("circle:last-child")!
    expect(swatch("blocked-by").getAttribute("class")).toBe(dot("Blocked by a: Title a").getAttribute("class"))
    expect(swatch("blocks").getAttribute("class")).toBe(dot("Blocks d: Title d").getAttribute("class"))
    const now = screen.getByTestId("gantt-now")
    expect(swatch("now").getAttribute("class")).toBe(now.getAttribute("class"))
    expect(swatch("now").getAttribute("stroke-dasharray")).toBe(now.getAttribute("stroke-dasharray"))
    expect(legend.querySelector('[data-testid="legend-connector"]')?.textContent).toMatch(/Blocks/)
    expect(legend.querySelectorAll("li")).toHaveLength(8)
  }, 20_000)

  test("missing dependency data shows the notice and draws no arrows", async () => {
    blocksAnswer = { blockedBy: {}, degraded: { reason: "error", message: "failed to open database" } }
    setFiltersPreference(FILTERS)
    await mounted()
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Blocked-by markers are unavailable/), {
      timeout: 5_000,
    })
    expect(screen.queryAllByTestId("gantt-arrow")).toEqual([])
    expect(screen.queryAllByTestId("gantt-marker")).toEqual([])
  }, 20_000)

  test("clicking a title stores the selection and switches to the Beads view", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(screen.getByTitle("b: Title b"))
    await waitFor(() => expect(screen.getByText("BEADS VIEW")).toBeTruthy(), { timeout: 5_000 })
    expect(getSelectedBead()).toBe("b")
  }, 20_000)
})

describe("Chart view — stepwise zoom (beadbox-aqn.2.2)", () => {
  const pressed = () =>
    ["Fit", "Hours", "Days", "Weeks"].filter(
      (name) => screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true",
    )
  const zoomIn = () => screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement
  const zoomOut = () => screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement

  test("− from Days steps through unhighlighted levels and lands on Weeks on the 4th press", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(screen.getByRole("button", { name: "Days" }))
    expect(pressed()).toEqual(["Days"])
    for (let i = 0; i < 3; i++) {
      fireEvent.click(zoomOut())
      expect(pressed()).toEqual([])
    }
    fireEvent.click(zoomOut())
    expect(pressed()).toEqual(["Weeks"])
  }, 20_000)

  test("+ from Fit leaves Fit", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    expect(pressed()).toEqual(["Fit"])
    fireEvent.click(zoomIn())
    expect(pressed()).not.toContain("Fit")
  }, 20_000)

  test("the buttons are disabled at the limits", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(screen.getByRole("button", { name: "Hours" }))
    fireEvent.click(zoomIn())
    fireEvent.click(zoomIn())
    expect(zoomIn().disabled).toBe(true)
    expect(zoomOut().disabled).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Weeks" }))
    fireEvent.click(zoomOut())
    expect(zoomOut().disabled).toBe(true)
    expect(zoomIn().disabled).toBe(false)
  }, 20_000)

  test("+ keeps the moment at the centre of the view in place", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(screen.getByRole("button", { name: "Hours" }))
    const scroller = screen.getByTestId("gantt-scroll")
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 400 })
    const width = () => Number(screen.getByTestId("gantt-timeline").getAttribute("width"))
    const before = width()
    scroller.scrollLeft = 3_000
    const centreFraction = (3_000 + 200) / before
    fireEvent.click(zoomIn())
    const after = width()
    expect(after).toBeGreaterThan(before * 2) // one Hours-band step is about ×2.13
    expect((scroller.scrollLeft + 200) / after).toBeCloseTo(centreFraction, 6)
  }, 20_000)

  test("a preset name stored before the ladder restores that preset", async () => {
    sessionStorage.setItem("beadbox:chart-zoom", JSON.stringify("days"))
    setFiltersPreference(FILTERS)
    await mounted()
    expect(pressed()).toEqual(["Days"])
  }, 20_000)
})

describe("useNow", () => {
  test("advances on its interval and stops when unmounted", async () => {
    const { useNow } = await import("../components/chart-view")
    const cleared = mock()
    const realClear = globalThis.clearInterval
    globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
      cleared(id)
      realClear(id)
    }) as typeof clearInterval
    try {
      const { result, unmount } = renderHook(() => useNow(20))
      const first = result.current
      await act(() => new Promise((resolve) => setTimeout(resolve, 60)))
      expect(result.current).toBeGreaterThan(first)
      unmount()
      expect(cleared).toHaveBeenCalled()
    } finally {
      globalThis.clearInterval = realClear
    }
  })
})
