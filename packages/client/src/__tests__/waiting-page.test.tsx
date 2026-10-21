// The Waiting view: open gates from rpc.gates.listWaiting, and the Resolve
// action for human gates (confirm -> rpc.gates.resolveHumanGate -> refetch).
// The header tab exists only while at least one gate is open, like Trains; it
// asks rpc.gates.hasOpenGate, so a resolve must refresh both.

import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { toast } from "sonner"
import { StartupGate } from "../components/startup-gate"
import { queryClient } from "../lib/query-client"
import { _setRpc, type RemoteApi } from "../lib/rpc"
import type { Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

const ws: Workspace = {
  id: "5d0c6f1e-0000-4000-8000-00000000a417",
  name: "waiting-ws",
  path: "/tmp/waiting-ws",
  databasePath: "/tmp/waiting-ws/.beads",
  mode: "embedded",
}

type Gate = {
  id: string
  title: string
  description: string
  awaitType: string
  awaitId?: string
  createdAt: string
  timeoutMs?: number
  deadline?: string
  held: Array<{ id: string; title: string; status: string; issueType: string; via?: string }>
  heldTruncated?: boolean
}

const HUMAN: Gate = {
  id: "gt-epb",
  title: "Gate: owner sign-off",
  description: "Ad-hoc gate blocking gt-a6g",
  awaitType: "human",
  createdAt: "2026-10-20T11:51:29Z",
  held: [
    { id: "gt-a6g", title: "Release epic", status: "open", issueType: "epic" },
    { id: "gt-a6g.1", title: "Child A", status: "open", issueType: "task", via: "gt-a6g" },
  ],
}
const TIMER: Gate = {
  id: "gt-416",
  title: "Gate: timer",
  description: "Ad-hoc gate blocking gt-6j9",
  awaitType: "timer",
  createdAt: "2026-10-20T11:51:31Z",
  timeoutMs: 7_200_000,
  deadline: "2026-10-20T13:51:31.000Z",
  held: [{ id: "gt-6j9", title: "Deploy", status: "open", issueType: "task" }],
}
const RUN: Gate = {
  id: "gt-61f",
  title: "Gate: gh:run 123456789",
  description: "Ad-hoc gate blocking gt-6j9",
  awaitType: "gh:run",
  awaitId: "123456789",
  createdAt: "2026-10-20T11:51:32Z",
  held: [{ id: "gt-6j9", title: "Deploy", status: "open", issueType: "task" }],
}
const PR: Gate = {
  id: "gt-7pq",
  title: "Gate: gh:pr 42",
  description: "",
  awaitType: "gh:pr",
  awaitId: "42",
  createdAt: "2026-10-20T11:51:33Z",
  held: [],
}
const BEAD: Gate = {
  id: "gt-b3d",
  title: "Gate: bead",
  description: "",
  awaitType: "bead",
  awaitId: "rig:gt-x9",
  createdAt: "2026-10-20T11:51:34Z",
  held: [],
}

// Held lists cut by the sidecar's bounds (beadbox-sun FIX-1): one capped, one
// whose list the view's budget used up.
const CAPPED: Gate = {
  id: "gt-cap",
  title: "Gate: big epic",
  description: "",
  awaitType: "human",
  createdAt: "2026-10-20T11:51:35Z",
  held: [
    { id: "gt-big", title: "Big epic", status: "open", issueType: "epic" },
    { id: "gt-big.1", title: "Child 1", status: "open", issueType: "task", via: "gt-big" },
  ],
  heldTruncated: true,
}
const STARVED: Gate = {
  id: "gt-late",
  title: "Gate: late",
  description: "",
  awaitType: "human",
  createdAt: "2026-10-20T11:51:36Z",
  held: [],
  heldTruncated: true,
}

let gates: Gate[] = []
let resolveResult: { success: boolean; error?: string } = { success: true }
let resolveRejects = false
// A handler timeout where bd still finished: the gate is closed, the call rejects.
let resolveClosesThenRejects = false
const listWaiting = mock(async (_dbPath?: string) => ({ success: true as const, data: gates }))
const hasOpenGate = mock(async (_dbPath?: string) => ({
  success: true as const,
  data: gates.length > 0,
}))
const resolveHumanGate = mock(async (id: string, _dbPath?: string, _reason?: string) => {
  if (resolveRejects) throw new Error("RPC timed out")
  if (resolveClosesThenRejects) {
    gates = gates.filter((gate) => gate.id !== id)
    throw new Error("RPC timed out")
  }
  if (resolveResult.success) gates = gates.filter((gate) => gate.id !== id)
  return resolveResult
})

let WaitingPage: typeof import("../components/waiting-page").WaitingPage

beforeAll(async () => {
  const anyCall = () => mock(() => Promise.resolve({ success: true, data: [], epics: [] }))
  const api = {
    health: {
      runStartupHealth: mock(() =>
        Promise.resolve({
          platform: "darwin",
          hasWorkspaces: true,
          workspaces: [ws],
          activeWorkspaceId: ws.id,
          healthCheck: { ok: true as const },
          bdVersion: "1.3.1",
          bdPath: "/opt/homebrew/bin/bd",
        }),
      ),
    },
    workspaces: new Proxy(
      { getWorkspaces: mock(() => Promise.resolve([ws])) },
      { get: (t, k) => (k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve())) },
    ),
    gates: { hasOpenGate, listWaiting, resolveHumanGate },
  }
  _setRpc(
    new Proxy(api, {
      get: (t, k) => (k in t ? t[k as keyof typeof t] : new Proxy({}, { get: anyCall })),
    }) as unknown as RemoteApi,
  )
  WaitingPage = (await import("../components/waiting-page")).WaitingPage
})

beforeEach(() => {
  gates = [HUMAN, TIMER, RUN, PR, BEAD]
  resolveResult = { success: true }
  resolveRejects = false
  resolveClosesThenRejects = false
  listWaiting.mockClear()
  hasOpenGate.mockClear()
  resolveHumanGate.mockClear()
  setWorkspaceCookie(ws.id)
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
})

function renderWaiting() {
  const rootRoute = createRootRoute({
    component: () => (
      <StartupGate>
        <Outlet />
      </StartupGate>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/waiting", component: WaitingPage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>beads-home</p> }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/waiting"] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
  return router
}

function waitingTabCount() {
  return screen.queryAllByRole("button", { name: "Waiting" }).length
}

async function findGateCards() {
  await screen.findByRole("heading", { name: "Waiting" }, { timeout: 5_000 })
  return screen.findAllByTestId("waiting-gate", {}, { timeout: 5_000 })
}

describe("Waiting view", () => {
  test("shows an empty state when nothing waits, and no Waiting tab", async () => {
    gates = []
    renderWaiting()
    expect(await screen.findByText("Nothing is waiting", {}, { timeout: 5_000 })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Back to Beads" })).toBeTruthy()
    expect(waitingTabCount()).toBe(0)
  }, 20_000)

  test("the header shows the Waiting tab while a gate is open", async () => {
    renderWaiting()
    await findGateCards()
    await waitFor(() => expect(waitingTabCount()).toBe(1))
  }, 20_000)

  test("resolving the last gate while open: 'Nothing is waiting', tab gone, link back to Beads", async () => {
    gates = [HUMAN]
    const router = renderWaiting()
    const cards = await findGateCards()
    await waitFor(() => expect(waitingTabCount()).toBe(1))
    fireEvent.click(within(cards[0]!).getByRole("button", { name: "Resolve" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }))

    expect(await screen.findByText("Nothing is waiting", {}, { timeout: 5_000 })).toBeTruthy()
    await waitFor(() => expect(waitingTabCount()).toBe(0))
    fireEvent.click(screen.getByRole("button", { name: "Back to Beads" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/"))
  }, 20_000)

  test("⌘1 from the Waiting view goes to Beads", async () => {
    const router = renderWaiting()
    await findGateCards()
    fireEvent.keyDown(window, { key: "1", metaKey: true })
    await waitFor(() => expect(router.state.location.pathname).toBe("/"))
  }, 20_000)

  test("lists each gate with its type, what it holds and what it waits on", async () => {
    renderWaiting()
    const cards = await findGateCards()
    expect(cards.length).toBe(5)
    expect(listWaiting).toHaveBeenCalledWith(ws.databasePath)

    const human = within(cards[0]!)
    expect(human.getByText("human gate")).toBeTruthy()
    expect(human.getByText("Gate: owner sign-off")).toBeTruthy()
    expect(human.getByText(/^waiting since /)).toBeTruthy()
    expect(human.getByText("Child A")).toBeTruthy()
    expect(human.getByText(/via gt-a6g/)).toBeTruthy()

    const timer = within(cards[1]!)
    expect(timer.getByText("timer gate")).toBeTruthy()
    expect(timer.getByTitle(TIMER.deadline as string)).toBeTruthy()

    // The awaited id exactly as bd gave it; bd returns no run or PR status.
    const run = within(cards[2]!)
    expect(run.getByText("gh:run gate")).toBeTruthy()
    expect(run.getByText("awaits 123456789")).toBeTruthy()
    const pr = within(cards[3]!)
    expect(pr.getByText("gh:pr gate")).toBeTruthy()
    expect(pr.getByText("awaits 42")).toBeTruthy()
    const bead = within(cards[4]!)
    expect(bead.getByText("bead gate")).toBeTruthy()
    expect(bead.getByText("awaits rig:gt-x9")).toBeTruthy()
  }, 20_000)

  test("a capped held list says so and names bd dep list for that gate", async () => {
    gates = [HUMAN, CAPPED]
    renderWaiting()
    const cards = await findGateCards()
    const capped = within(cards[1]!).getByTestId("held-capped")
    expect(capped.textContent).toBe(
      "Showing the first 2 beads this gate holds. For all of them: bd dep list gt-cap",
    )
    expect(within(capped).getByText("bd dep list gt-cap").tagName).toBe("CODE")
    // An uncut list carries no such line.
    expect(within(cards[0]!).queryAllByTestId("held-capped").length).toBe(0)
  }, 20_000)

  test("a list the view's limit used up is not 'Holds no open issues'", async () => {
    gates = [PR, STARVED]
    renderWaiting()
    const cards = await findGateCards()
    expect(within(cards[1]!).getByTestId("held-budget-spent").textContent).toBe(
      "Held beads not listed here; the view's limit of 5000 is used up. For this gate: bd dep list gt-late",
    )
    expect(within(cards[1]!).queryAllByText("Holds no open issues.").length).toBe(0)
    // A gate that truly holds nothing still says so.
    expect(within(cards[0]!).getByText("Holds no open issues.")).toBeTruthy()
  }, 20_000)

  test("the Resolve prompt never presents a cut count as exact", async () => {
    gates = [HUMAN, CAPPED, STARVED]
    renderWaiting()
    const prompt = async (index: number) => {
      const cards = await findGateCards()
      fireEvent.click(within(cards[index]!).getByRole("button", { name: "Resolve" }))
      const dialog = await screen.findByRole("alertdialog")
      const text = dialog.textContent ?? ""
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
      await waitFor(() => expect(screen.queryAllByRole("alertdialog").length).toBe(0))
      return text
    }
    expect(await prompt(0)).toContain("Anything it holds (2 open) is released")
    expect(await prompt(1)).toContain("Anything it holds (at least 2 open) is released")
    expect(await prompt(2)).toContain("Anything it holds (at least 1 open) is released")
    expect(resolveHumanGate).not.toHaveBeenCalled()
  }, 30_000)

  test("offers Resolve on human gates only", async () => {
    renderWaiting()
    const cards = await findGateCards()
    // Counts, not elements: a failing matcher on a DOM node prints the whole
    // happy-dom window.
    const resolveButtons = cards.map(
      (card) => within(card).queryAllByRole("button", { name: "Resolve" }).length,
    )
    expect(resolveButtons).toEqual([1, 0, 0, 0, 0])
  }, 20_000)

  test("Resolve asks first; Cancel runs nothing", async () => {
    renderWaiting()
    const cards = await findGateCards()
    fireEvent.click(within(cards[0]!).getByRole("button", { name: "Resolve" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(`Resolve gate ${HUMAN.id}?`)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryAllByRole("alertdialog").length).toBe(0))
    expect(resolveHumanGate).not.toHaveBeenCalled()
  }, 20_000)

  test("confirming resolves through bd and refetches the list", async () => {
    renderWaiting()
    const cards = await findGateCards()
    fireEvent.click(within(cards[0]!).getByRole("button", { name: "Resolve" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: "Design approved" },
    })
    const callsBefore = listWaiting.mock.calls.length
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }))

    await waitFor(() => expect(screen.getAllByTestId("waiting-gate").length).toBe(4))
    expect(resolveHumanGate).toHaveBeenCalledWith(HUMAN.id, ws.databasePath, "Design approved")
    expect(listWaiting.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(screen.queryAllByRole("alertdialog").length).toBe(0)
  }, 20_000)

  test("a failed resolve keeps the dialog open and the gate listed", async () => {
    resolveResult = { success: false, error: "gt-epb is not a gate" }
    renderWaiting()
    const cards = await findGateCards()
    fireEvent.click(within(cards[0]!).getByRole("button", { name: "Resolve" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }))

    await waitFor(() => expect(resolveHumanGate).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Resolve" })).toHaveProperty(
        "disabled",
        false,
      ),
    )
    expect(screen.getByRole("alertdialog")).toBeTruthy()
    expect(screen.getAllByTestId("waiting-gate").length).toBe(5)
  }, 20_000)

  test("a rejected resolve shows an error toast and re-enables the dialog", async () => {
    resolveRejects = true
    const errorToast = spyOn(toast, "error").mockImplementation(() => "")
    try {
      renderWaiting()
      const cards = await findGateCards()
      fireEvent.click(within(cards[0]!).getByRole("button", { name: "Resolve" }))
      const dialog = await screen.findByRole("alertdialog")
      fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }))

      await waitFor(() => expect(errorToast).toHaveBeenCalledTimes(1))
      expect(errorToast.mock.calls[0]?.[0]).toBe("Failed to resolve gate")
      expect(errorToast.mock.calls[0]?.[1]).toEqual({ description: "RPC timed out" })
      await waitFor(() =>
        expect(within(dialog).getByRole("button", { name: "Resolve" })).toHaveProperty(
          "disabled",
          false,
        ),
      )
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty(
        "disabled",
        false,
      )
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
      await waitFor(() => expect(screen.queryAllByRole("alertdialog").length).toBe(0))
    } finally {
      errorToast.mockRestore()
    }
  }, 20_000)

  test("a resolve that times out after bd closed the gate still refetches", async () => {
    gates = [HUMAN]
    resolveClosesThenRejects = true
    const errorToast = spyOn(toast, "error").mockImplementation(() => "")
    try {
      renderWaiting()
      const cards = await findGateCards()
      await waitFor(() => expect(waitingTabCount()).toBe(1))
      fireEvent.click(within(cards[0]!).getByRole("button", { name: "Resolve" }))
      const dialog = await screen.findByRole("alertdialog")
      fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }))

      await waitFor(() => expect(errorToast).toHaveBeenCalledTimes(1))
      // Without a refetch the closed gate would stay listed until the next
      // change event.
      expect(await screen.findByText("Nothing is waiting", {}, { timeout: 5_000 })).toBeTruthy()
      await waitFor(() => expect(waitingTabCount()).toBe(0))
    } finally {
      errorToast.mockRestore()
    }
  }, 20_000)

  test("never shows 'Nothing is waiting' before the first load", async () => {
    // Check every subtree React inserts, at the moment it is inserted, so a
    // one-render flash is caught even though the next render replaces it.
    let flashed = false
    const check = (node: Node) => {
      if (node.textContent?.includes("Nothing is waiting")) flashed = true
    }
    const proto = Node.prototype
    const { appendChild, insertBefore } = proto
    proto.appendChild = function <T extends Node>(this: Node, node: T): T {
      check(node)
      return appendChild.call(this, node) as T
    }
    proto.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
      check(node)
      return insertBefore.call(this, node, child) as T
    }
    try {
      renderWaiting()
      await findGateCards()
    } finally {
      proto.appendChild = appendChild
      proto.insertBefore = insertBefore
    }
    expect(flashed).toBe(false)
  }, 20_000)

  test("the Waiting view loads the full list; the header asks only for presence", async () => {
    renderWaiting()
    await findGateCards()
    await waitFor(() => expect(waitingTabCount()).toBe(1))
    expect(hasOpenGate).toHaveBeenCalledWith(ws.databasePath)
    expect(listWaiting).toHaveBeenCalledWith(ws.databasePath)
  }, 20_000)
})
