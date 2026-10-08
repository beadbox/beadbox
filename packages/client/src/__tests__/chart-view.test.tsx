// Chart view (PR #51): rendering, shared filters, collapse, bar styles,
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

// Tests that need a different hierarchy swap this; afterEach restores it.
let treeFn: () => Epic[] = () => tree()

function tree(): Epic[] {
  return [
    {
      ...bead("E1", { type: "epic", title: "Epic one", status: "in_progress" }),
      children: [
        bead("a", { assignee: "alice", status: "in_progress", startedAt: day(2) }),
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
        incrementalRefresh: mock(() => Promise.resolve({ success: true as const, epics: treeFn() })),
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
  treeFn = () => tree()
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
    // c is closed with no start time from bd: placed, and drawn as inferred.
    expect(barFor("c")?.getAttribute("data-style")).toBe("done inferred")
    expect(barFor("c")?.getAttribute("stroke-dasharray")).toBe("1 2")
    expect(barFor("a")?.getAttribute("stroke-dasharray")).toBeNull() // a has bd's started_at
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

  test("the timeline scroller is the only scroll container and holds no titles (PR #51)", async () => {
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
    expect(swatch("inferred").getAttribute("stroke-dasharray")).toBe(barFor("c")!.getAttribute("stroke-dasharray"))
    expect(swatch("inferred").getAttribute("fill-opacity")).toBe(barFor("c")!.getAttribute("fill-opacity"))
    // Markers and the now line.
    const dot = (label: string) =>
      screen.getAllByTestId("gantt-marker").find((el) => el.getAttribute("aria-label") === label)!.querySelector("circle:last-child")!
    expect(swatch("blocked-by").getAttribute("class")).toBe(dot("Blocked by a: Title a").getAttribute("class"))
    expect(swatch("blocks").getAttribute("class")).toBe(dot("Blocks d: Title d").getAttribute("class"))
    const now = screen.getByTestId("gantt-now")
    expect(swatch("now").getAttribute("class")).toBe(now.getAttribute("class"))
    expect(swatch("now").getAttribute("stroke-dasharray")).toBe(now.getAttribute("stroke-dasharray"))
    expect(legend.querySelector('[data-testid="legend-connector"]')?.textContent).toMatch(/Blocks/)
    expect(legend.querySelectorAll("li")).toHaveLength(9)
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

  test("clicking a bead's bar does what clicking its title does (PR #53)", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(barFor("c")!)
    await waitFor(() => expect(screen.getByText("BEADS VIEW")).toBeTruthy(), { timeout: 5_000 })
    expect(getSelectedBead()).toBe("c")
  }, 20_000)

  test("the title column resizes by drag between 300 and 600 px (PR #53)", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const handle = screen.getByRole("separator", { name: "Resize bead titles" })
    const column = () => Number.parseInt((handle.parentElement as HTMLElement).style.width, 10)
    const drag = (from: number, to: number) => {
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: from })
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: to })
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: to })
    }
    expect(column()).toBe(300)
    drag(500, 650)
    expect(column()).toBe(450)
    expect(handle.getAttribute("aria-valuenow")).toBe("450")
    drag(500, 2_000)
    expect(column()).toBe(600)
    drag(500, -2_000)
    expect(column()).toBe(300)
    // A move without a press does nothing.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 })
    expect(column()).toBe(300)
  }, 20_000)

  test("dragging the title handle selects no text, and selection works again afterwards", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const handle = () => screen.getByRole("separator", { name: "Resize bead titles" })
    const column = () => Number.parseInt((handle().parentElement as HTMLElement).style.width, 10)
    document.body.style.userSelect = "text"
    // fireEvent returns false when the handler cancelled the default.
    expect(fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 500 })).toBe(false)
    expect(document.body.style.userSelect).toBe("none")
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 600 })
    expect(column()).toBe(400)
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 600 })
    expect(document.body.style.userSelect).toBe("text")
    fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 500 })
    expect(document.body.style.userSelect).toBe("none")
    fireEvent.pointerCancel(handle(), { pointerId: 1 })
    expect(document.body.style.userSelect).toBe("text")
    // Unmounting mid-drag restores it too.
    fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 500 })
    expect(document.body.style.userSelect).toBe("none")
    cleanup()
    expect(document.body.style.userSelect).toBe("text")
    document.body.style.userSelect = ""
  }, 20_000)

  test("arrow keys resize the title column, and the width survives a remount", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const handle = () => screen.getByRole("separator", { name: "Resize bead titles" })
    fireEvent.keyDown(handle(), { key: "ArrowRight" })
    fireEvent.keyDown(handle(), { key: "ArrowRight" })
    expect(handle().getAttribute("aria-valuenow")).toBe("332")
    fireEvent.keyDown(handle(), { key: "ArrowLeft" })
    expect(handle().getAttribute("aria-valuenow")).toBe("316")
    cleanup()
    queryClient.clear()
    _resetWorkspaceSessions()
    await mounted()
    expect(handle().getAttribute("aria-valuenow")).toBe("316")
  }, 20_000)

  test("clicking a summary bar opens nothing", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(screen.getAllByTestId("gantt-summary-bar")[0])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText("BEADS VIEW")).toBeNull()
    expect(getSelectedBead()).toBeNull()
  }, 20_000)
})

describe("Chart view — stepwise zoom (PR #51)", () => {
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
    expect(zoomIn().disabled).toBe(false) // three steps past Hours now (beadbox-ct5)
    fireEvent.click(zoomIn())
    expect(zoomIn().disabled).toBe(true)
    expect(zoomOut().disabled).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Weeks" }))
    fireEvent.click(zoomOut())
    expect(zoomOut().disabled).toBe(true)
    expect(zoomIn().disabled).toBe(false)
  }, 20_000)

  // Zoom changes put now at 75% of the visible timeline (PR #53).
  const VIEW_W = 400
  const fixViewport = () => {
    const scroller = screen.getByTestId("gantt-scroll")
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: VIEW_W })
    return scroller
  }
  const nowX = () => Number(screen.getByTestId("gantt-now").getAttribute("x1"))
  const expectNowAtThreeQuarters = (scroller: HTMLElement) => {
    expect(nowX() - scroller.scrollLeft).toBeCloseTo(0.75 * VIEW_W, 6)
  }

  test("+ puts now at 75% of the view", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(screen.getByRole("button", { name: "Hours" }))
    const scroller = fixViewport()
    scroller.scrollLeft = 0
    fireEvent.click(zoomIn())
    expectNowAtThreeQuarters(scroller)
  }, 20_000)

  test("near the end of the timeline the view scrolls as far as it can, with now still visible", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(screen.getByRole("button", { name: "Days" }))
    const scroller = fixViewport()
    scroller.scrollLeft = 0
    fireEvent.click(zoomIn()) // little timeline left after now at this scale
    const contentW = Number(screen.getByTestId("gantt-timeline").getAttribute("width"))
    expect(scroller.scrollLeft).toBeCloseTo(Math.max(contentW - VIEW_W, 0), 6)
    expect(nowX() - scroller.scrollLeft).toBeGreaterThan(0.75 * VIEW_W)
    expect(nowX() - scroller.scrollLeft).toBeLessThanOrEqual(VIEW_W)
  }, 20_000)

  test("choosing a preset puts now at 75% of the view; Fit leaves the scroll alone", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const scroller = fixViewport()
    scroller.scrollLeft = 0
    fireEvent.click(screen.getByRole("button", { name: "Hours" }))
    expectNowAtThreeQuarters(scroller)
    scroller.scrollLeft = 123
    fireEvent.click(screen.getByRole("button", { name: "Fit" }))
    expect(scroller.scrollLeft).toBe(123)
  }, 20_000)

  test("with every bead in the past, + keeps the moment at the centre in place", async () => {
    treeFn = () => [
      {
        ...bead("P", { type: "epic", title: "Past epic", status: "closed", closedAt: day(5) }),
        children: [bead("p1", { status: "closed", closedAt: day(3) }), bead("p2", { status: "closed", closedAt: day(5) })],
        childEpics: [],
      },
    ]
    blocksAnswer = { blockedBy: {} }
    setFiltersPreference(FILTERS)
    await mounted()
    expect(screen.queryByTestId("gantt-now")).toBeNull() // now is not on this timeline
    fireEvent.click(screen.getByRole("button", { name: "Hours" }))
    const scroller = fixViewport()
    const width = () => Number(screen.getByTestId("gantt-timeline").getAttribute("width"))
    const before = width()
    scroller.scrollLeft = 3_000
    const centreFraction = (3_000 + VIEW_W / 2) / before
    fireEvent.click(zoomIn())
    const after = width()
    expect(after).toBeGreaterThan(before * 2) // one Hours-band step is about ×2.13
    expect((scroller.scrollLeft + VIEW_W / 2) / after).toBeCloseTo(centreFraction, 6)
  }, 20_000)

  test("a fractional zoom (left by a pinch) restores unhighlighted, and +/- go to the next whole step", async () => {
    sessionStorage.setItem("beadbox:chart-zoom", JSON.stringify({ kind: "level", level: 8.5 }))
    setFiltersPreference(FILTERS)
    await mounted()
    expect(pressed()).toEqual([])
    fireEvent.click(zoomOut()) // 8.5 -> 8 = Hours
    expect(pressed()).toEqual(["Hours"])
    sessionStorage.setItem("beadbox:chart-zoom", JSON.stringify({ kind: "level", level: 8.5 }))
    cleanup()
    queryClient.clear()
    _resetWorkspaceSessions()
    await mounted()
    fireEvent.click(zoomIn()) // 8.5 -> 9
    expect(pressed()).toEqual([])
    fireEvent.click(zoomOut()) // 9 -> 8 = Hours
    expect(pressed()).toEqual(["Hours"])
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

describe("Chart view — links across epics (PR #53)", () => {
  const toggle = () => screen.getByRole("button", { name: "Links across epics" })
  const crossPaths = () => document.querySelectorAll('[data-testid="gantt-arrow"][data-cross="true"]')
  const markerLabels = () => screen.queryAllByTestId("gantt-marker").map((el) => el.getAttribute("aria-label"))
  const pathPoints = (path: Element) =>
    path
      .getAttribute("d")!
      .split(/[ML]/)
      .filter(Boolean)
      .map((p) => p.trim().split(",").map(Number))
  const summaryBarAt = (y: number) =>
    screen.getAllByTestId("gantt-summary-bar").find((r) => {
      const top = Number(r.getAttribute("y"))
      return y >= top - 4 && y <= top + Number(r.getAttribute("height")) + 4
    })

  test("off by default: a dependency across epics is shown as dots only", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    expect(toggle().getAttribute("aria-pressed")).toBe("false")
    expect(crossPaths()).toHaveLength(0)
    expect(markerLabels()).toContain("Blocked by a: Title a")
    expect(markerLabels()).toContain("Blocks d: Title d")
  }, 20_000)

  test("on: a connector from the blocker's end edge to the dependent's start edge replaces the dots", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(toggle())
    expect(toggle().getAttribute("aria-pressed")).toBe("true")
    const [path] = crossPaths()
    expect(path.getAttribute("data-from")).toBe("a")
    expect(path.getAttribute("data-to")).toBe("d")
    const points = pathPoints(path)
    const [first, last, beforeLast] = [points[0], points[points.length - 1], points[points.length - 2]]
    const [a, d] = [barFor("a")!, barFor("d")!]
    expect(first[0]).toBeCloseTo(Number(a.getAttribute("x")) + Number(a.getAttribute("width")))
    expect(last[0]).toBeCloseTo(Number(d.getAttribute("x")))
    expect(beforeLast[0]).toBeLessThan(last[0]) // heading right into the start edge
    expect(markerLabels()).not.toContain("Blocked by a: Title a")
    expect(markerLabels()).not.toContain("Blocks d: Title d")
  }, 20_000)

  test("the dependent's epic collapsed: the connector ends at that epic's summary bar", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole("button", { name: /Epic two/ }))
    const [path] = crossPaths()
    expect(path.getAttribute("data-to")).toBe("E2")
    const last = pathPoints(path).at(-1)!
    const bar = summaryBarAt(last[1])!
    expect(last[0]).toBeCloseTo(Number(bar.getAttribute("x")))
  }, 20_000)

  test("both epics collapsed: several links become one connector between the headers", async () => {
    blocksAnswer = { blockedBy: { d: ["a", "b", "c"] } }
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(toggle())
    expect(crossPaths()).toHaveLength(3)
    fireEvent.click(screen.getByRole("button", { name: /Epic one/ }))
    fireEvent.click(screen.getByRole("button", { name: /Epic two/ }))
    expect(crossPaths()).toHaveLength(1)
    expect([crossPaths()[0].getAttribute("data-from"), crossPaths()[0].getAttribute("data-to")]).toEqual(["E1", "E2"])
  }, 20_000)

  test("a bead in a child epic of a collapsed epic links to the outer epic's header", async () => {
    treeFn = () => {
      const [e1, e2] = tree()
      const child = { ...bead("E2c", { type: "epic", title: "Child epic" }), children: [bead("n", { assignee: "bob" })], childEpics: [] }
      return [e1, { ...e2, childEpics: [child] }]
    }
    blocksAnswer = { blockedBy: { n: ["a"] } }
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole("button", { name: /Child epic/ }))
    expect(crossPaths()[0].getAttribute("data-to")).toBe("E2c")
    fireEvent.click(screen.getByRole("button", { name: /Epic two/ }))
    expect(crossPaths()[0].getAttribute("data-to")).toBe("E2")
  }, 20_000)

  test("a blocker hidden by filters keeps its dot and gets no connector", async () => {
    setFiltersPreference({ ...FILTERS, assignee: "bob" }) // a (alice) is hidden; d (bob) is shown
    await mounted()
    fireEvent.click(toggle())
    expect(crossPaths()).toHaveLength(0)
    expect(markerLabels()).toContain("Blocked by a: Title a")
  }, 20_000)
})

describe("Chart view — minute labels past Hours (PR #53)", () => {
  const axisLabels = () =>
    Array.from(screen.getByTestId("gantt-header-row").querySelectorAll("text")).map((t) => t.textContent ?? "")
  const minutesOf = (labels: string[]) => new Set(labels.filter((l) => /^\d\d:\d\d$/.test(l)).map((l) => l.slice(3)))

  test("Hours labels full hours; + once adds :30, + twice adds :15 and :45", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(screen.getByRole("button", { name: "Hours" }))
    expect([...minutesOf(axisLabels())]).toEqual(["00"])
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(minutesOf(axisLabels())).toEqual(new Set(["00", "30"]))
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(minutesOf(axisLabels())).toEqual(new Set(["00", "15", "30", "45"]))
  }, 20_000)
})

describe("Chart view — keeps its view across views (beadbox-ct5)", () => {
  const scroller = () => screen.getByTestId("gantt-scroll")
  const nowX = () => Number(screen.getByTestId("gantt-now").getAttribute("x1"))
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60)) // one animation frame and then some
  const remount = async () => {
    cleanup()
    queryClient.clear()
    _resetWorkspaceSessions()
    await mounted()
  }
  // Scroll somewhere at Hours and return the now line's offset in the view,
  // which pins down the visible time window independently of the domain.
  const leaveAt = async (left: number, top: number) => {
    fireEvent.click(screen.getByRole("button", { name: "Hours" }))
    scroller().scrollLeft = left
    scroller().scrollTop = top
    fireEvent.scroll(scroller())
    await settle()
    return nowX() - left
  }

  test("coming back restores the zoom, the time window and the vertical position", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const offset = await leaveAt(500, 56)
    await remount()
    expect(screen.getByRole("button", { name: "Hours" }).getAttribute("aria-pressed")).toBe("true")
    expect(nowX() - scroller().scrollLeft).toBeCloseTo(offset, 0)
    expect(scroller().scrollTop).toBe(56)
    expect(screen.getByTestId("gantt-titles").scrollTop).toBe(56)
  }, 20_000)

  test("with an earlier bead added meanwhile, the same time window comes back", async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    const offset = await leaveAt(500, 0)
    const domainBefore = nowX()
    treeFn = () => {
      const [e1, e2] = tree()
      return [{ ...e1, children: [...e1.children, bead("old", { status: "closed", createdAt: day(-5), closedAt: day(-4) })] }, e2]
    }
    await remount()
    expect(nowX()).toBeGreaterThan(domainBefore) // the timeline now starts earlier
    expect(nowX() - scroller().scrollLeft).toBeCloseTo(offset, 0)
  }, 20_000)

  test("a missing or garbled saved view leaves the default view", async () => {
    sessionStorage.setItem("beadbox:chart-view", JSON.stringify({ leftTime: "yesterday", scrollTop: 10 }))
    setFiltersPreference(FILTERS)
    await mounted()
    expect(scroller().scrollLeft).toBe(0)
    expect(scroller().scrollTop).toBe(0)
  }, 20_000)
})

describe("Chart view — pinch to zoom (beadbox-ct5)", () => {
  const VIEW_W = 400
  const setup = async () => {
    setFiltersPreference(FILTERS)
    await mounted()
    fireEvent.click(screen.getByRole("button", { name: "Hours" }))
    const scroller = screen.getByTestId("gantt-scroll")
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: VIEW_W })
    return scroller
  }
  const width = () => Number(screen.getByTestId("gantt-timeline").getAttribute("width"))
  const pressed = () =>
    ["Fit", "Hours", "Days", "Weeks"].filter((name) => screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true")
  const gesture = (el: Element, type: string, props: Record<string, number> = {}) => {
    const e = Object.assign(new Event(type, { bubbles: true, cancelable: true }), props)
    act(() => {
      el.dispatchEvent(e)
    })
    return e
  }
  // happy-dom drops ctrlKey and clientX from WheelEvent's init; real webviews set them.
  const pinchWheel = (el: Element, deltaY: number, clientX: number) => {
    const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY })
    Object.defineProperty(e, "ctrlKey", { value: true })
    Object.defineProperty(e, "clientX", { value: clientX })
    act(() => {
      el.dispatchEvent(e)
    })
    return e
  }

  test("Ctrl+wheel zooms in smoothly, keeps the time under the pointer, and leaves no preset highlighted", async () => {
    const scroller = await setup()
    scroller.scrollLeft = 1_000
    const before = width()
    const pointer = 100
    const fraction = (1_000 + pointer) / before // where the pointer is on the timeline
    const wheel = pinchWheel(scroller, -30, pointer)
    expect(wheel.defaultPrevented).toBe(true) // the page itself must not zoom
    const after = width()
    expect(after / before).toBeCloseTo(Math.exp(0.3), 3) // smooth, not a ladder step
    expect((scroller.scrollLeft + pointer) / after).toBeCloseTo(fraction, 6)
    expect(pressed()).toEqual([])
  }, 20_000)

  test("a WebKit gesture with scale 2 doubles the scale", async () => {
    const scroller = await setup()
    const before = width()
    gesture(scroller, "gesturestart")
    const change = gesture(scroller, "gesturechange", { scale: 2, clientX: 200 })
    gesture(scroller, "gestureend")
    expect(change.defaultPrevented).toBe(true)
    expect(width() / before).toBeCloseTo(2, 3)
  }, 20_000)

  test("pinching past the limit stops there and disables +", async () => {
    const scroller = await setup()
    pinchWheel(scroller, -2_000, 100)
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true)
    pinchWheel(scroller, 5_000, 100)
    expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(true)
  }, 20_000)

  test("a plain wheel (no Ctrl) does not zoom", async () => {
    const scroller = await setup()
    const before = width()
    const notPrevented = fireEvent.wheel(scroller, { deltaY: -30, clientX: 100 })
    expect(notPrevented).toBe(true)
    expect(width()).toBe(before)
    expect(pressed()).toEqual(["Hours"])
  }, 20_000)
})
