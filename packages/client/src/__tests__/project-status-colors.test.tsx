// beadbox-t6x: in the All projects view each project's rows use that
// project's own status colors (o3h), one scoped stylesheet per project.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, waitFor } from "@testing-library/react"
import { ProjectStatusColors } from "../components/project-status-colors"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"

const COLORS: Record<string, Record<string, string>> = {
  a: { open: "#ff0000" },
  b: { open: "#0000ff" },
  plain: {},
}

beforeEach(() => {
  _setRpc({
    workspaces: {
      getStatusColors: (id: string) => Promise.resolve({ success: true, colors: COLORS[id] ?? {} }),
    },
    beads: {
      getAvailableStatuses: () => Promise.resolve(["open", "in_progress", "closed"]),
      getCustomStatusList: () => Promise.resolve([]),
    },
  } as unknown as RemoteApi)
})

afterEach(() => {
  cleanup()
  _resetRpc()
})

const source = (id: string) => ({ id, databasePath: `/p/${id}/.beads/beads.db` })
const sheet = (id: string) =>
  document.querySelector<HTMLStyleElement>(`style[data-beadbox-status-colors-project="${id}"]`)

function mount(ids: string[], client = new QueryClient()) {
  const ui = (list: string[]) => (
    <QueryClientProvider client={client}>
      <ProjectStatusColors sources={list.map(source)} />
    </QueryClientProvider>
  )
  const view = render(ui(ids))
  return { rerender: (list: string[]) => view.rerender(ui(list)) }
}

test("each project gets its own block, scoped to its rows, in its own colors", async () => {
  mount(["a", "b"])
  await waitFor(() => expect(sheet("a")?.textContent).toContain("rgb(255 0 0 / 0.2)"))
  await waitFor(() => expect(sheet("b")?.textContent).toContain("rgb(0 0 255 / 0.2)"))
  const a = sheet("a")?.textContent ?? ""
  const b = sheet("b")?.textContent ?? ""
  for (const rule of a.split("\n")) expect(rule.startsWith('[data-project-id="a"] ')).toBe(true)
  for (const rule of b.split("\n")) expect(rule.startsWith('[data-project-id="b"] ')).toBe(true)
  // No color crosses projects.
  expect(a).not.toContain("0 0 255")
  expect(b).not.toContain("255 0 0")
})

test("a project with no colors chosen adds no rules, so its rows keep the default classes", async () => {
  mount(["a", "plain"])
  await waitFor(() => expect(sheet("a")?.textContent).toContain("rgb(255 0 0 / 0.2)"))
  expect(sheet("plain")?.textContent ?? "").toBe("")
})

test("a project that leaves the registry drops its block", async () => {
  const view = mount(["a", "b"])
  await waitFor(() => expect(sheet("b")?.textContent).toContain("rgb(0 0 255 / 0.2)"))
  view.rerender(["a"])
  await waitFor(() => expect(sheet("b")).toBeNull())
  expect(sheet("a")?.textContent).toContain("rgb(255 0 0 / 0.2)")
})
