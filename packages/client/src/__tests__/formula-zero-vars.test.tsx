// A formula with no variables is a valid formula (beadbox-vco). bd omits the
// `vars` key from `bd formula show --json` entirely when the formula has no
// [vars] table or an empty one (checked at bd 1.1.0 and 1.2.2), so the detail
// the view receives has no `vars` at all. The view used to read
// Object.keys(detail.vars) on mount — in the panel and in both modals, which
// are mounted (closed) as soon as a detail loads — so opening Formulas crashed
// the app, and restoring the route and the saved selection on relaunch crashed
// it again every time.

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
import { cleanup, render, screen, waitFor } from "@testing-library/react"

import { FormulaPourModal } from "../components/formula-pour-modal"
import { FormulaPreviewModal } from "../components/formula-preview-modal"
import { StartupGate } from "../components/startup-gate"
import { setSelectedFormula } from "../lib/local-storage"
import { queryClient } from "../lib/query-client"
import { _setRpc, type RemoteApi } from "../lib/rpc"
import type { FormulaDetail, FormulaSummary, Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { _resetWorkspaceSessions } from "../lib/workspace-session-cache"

const ws: Workspace = {
  id: "3f1b8a24-0000-4000-8000-000000000vc0",
  name: "formulas-ws",
  path: "/tmp/formulas-ws",
  databasePath: "/tmp/formulas-ws/.beads",
  mode: "embedded",
}

const step = { id: "a", title: "Step A", type: "task" }

// Exactly what `bd formula show --json` returns for a formula with no vars:
// no `vars` key. The cast is the point — the old type claimed it was always there.
const zeroVars = {
  formula: "zero-vars",
  description: "Pours a fixed set of beads",
  version: 1,
  type: "workflow",
  source: "/tmp/formulas-ws/.beads/formulas/zero-vars.formula.toml",
  steps: [step],
} as FormulaDetail

const oneVar: FormulaDetail = {
  formula: "one-var",
  description: "Needs a version",
  version: 1,
  type: "workflow",
  source: "/tmp/formulas-ws/.beads/formulas/one-var.formula.toml",
  steps: [step],
  vars: { version: { description: "Version string", required: true } },
}

const details: Record<string, FormulaDetail> = { "zero-vars": zeroVars, "one-var": oneVar }

function summary(d: FormulaDetail): FormulaSummary {
  return {
    name: d.formula,
    type: d.type,
    description: d.description,
    source: d.source ?? "",
    steps: d.steps.length,
    vars: Object.keys(d.vars ?? {}).length,
  }
}

// The formula list each test serves, in bd's order.
let listed: FormulaDetail[] = []

let FormulasView: typeof import("../components/formulas-view").FormulasView

beforeAll(async () => {
  installRpc()
  FormulasView = (await import("../components/formulas-view")).FormulasView
})

function installRpc() {
  const benign = (): RemoteApi[keyof RemoteApi] =>
    new Proxy(
      {},
      { get: () => mock(() => Promise.resolve({ success: true, data: [], epics: [] })) },
    ) as never
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
    workspaces: new Proxy(
      { getWorkspaces: mock(() => Promise.resolve([ws])) },
      {
        get: (t, k) => (k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve())),
      },
    ),
    formulas: new Proxy(
      {
        loadFormulas: mock(() => Promise.resolve({ success: true, data: listed.map(summary) })),
        loadFormulaDetail: mock((name: string) =>
          Promise.resolve(
            details[name]
              ? { success: true, data: details[name] }
              : { success: false, error: `formula not found: ${name}` },
          ),
        ),
      },
      {
        get: (t, k) =>
          k in t ? t[k as keyof typeof t] : mock(() => Promise.resolve({ success: true, data: [] })),
      },
    ),
  }
  _setRpc(
    new Proxy(api, {
      get: (t, k) => (k in t ? t[k as keyof typeof t] : benign()),
    }) as unknown as RemoteApi,
  )
}

function mountFormulas() {
  const rootRoute = createRootRoute({
    component: () => (
      <StartupGate>
        <Outlet />
      </StartupGate>
    ),
  })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/formulas", component: FormulasView }),
    createRoute({ getParentRoute: () => rootRoute, path: "/workspaces", component: () => null }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/formulas"] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  queryClient.clear()
  _resetWorkspaceSessions()
  clearWorkspaceCookie()
  setSelectedFormula(null)
  listed = []
})

describe("formulas view with a zero-vars formula (beadbox-vco)", () => {
  test("opening Formulas auto-selects a zero-vars formula and renders it", async () => {
    setWorkspaceCookie(ws.id)
    listed = [zeroVars]
    mountFormulas()

    await waitFor(() => expect(screen.getByText("Pours a fixed set of beads")).toBeTruthy(), {
      timeout: 5_000,
    })
    expect(screen.queryByText("Variables")).toBeNull()
  })

  test("a relaunch that restores the saved zero-vars selection renders it (the crash-loop path)", async () => {
    setWorkspaceCookie(ws.id)
    listed = [oneVar, zeroVars]
    setSelectedFormula("zero-vars")
    mountFormulas()

    await waitFor(() => expect(screen.getByText("Pours a fixed set of beads")).toBeTruthy(), {
      timeout: 5_000,
    })
    expect(screen.queryByText("Variables")).toBeNull()
  })

  test("control: a formula with one var still shows it in the Variables panel", async () => {
    setWorkspaceCookie(ws.id)
    listed = [oneVar]
    mountFormulas()

    await waitFor(() => expect(screen.getByText("Needs a version")).toBeTruthy(), {
      timeout: 5_000,
    })
    expect(screen.getByText("Variables")).toBeTruthy()
    expect(screen.getByText("version")).toBeTruthy()
    expect(screen.getByText("required")).toBeTruthy()
  })
})

describe("formula modals with a zero-vars formula (beadbox-vco)", () => {
  test("the pour modal opens with no variable inputs", () => {
    render(<FormulaPourModal open onOpenChange={() => {}} formula={zeroVars} dbPath={ws.databasePath} />)
    expect(screen.getByText("Pour: zero-vars")).toBeTruthy()
    expect(screen.queryByText("Variables")).toBeNull()
    expect(document.querySelectorAll('input[type="text"]').length).toBe(1) // assignee only
  })

  test("the preview modal opens with no variable inputs", () => {
    render(<FormulaPreviewModal open onOpenChange={() => {}} formula={zeroVars} dbPath={ws.databasePath} />)
    expect(document.body.textContent).toContain("zero-vars")
    expect(document.querySelectorAll('input[type="text"]').length).toBe(0)
  })
})
