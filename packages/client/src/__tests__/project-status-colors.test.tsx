// beadbox-t6x: in the All projects view each project's rows use that
// project's own status colors (o3h), one scoped stylesheet per project.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, waitFor } from "@testing-library/react"
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

// REVERSED by the light-theme palette sweep. This previously asserted an
// empty sheet, because a built-in with no chosen colour kept the hardcoded
// Tailwind classes. Those are dark-only, and in THIS view there is no active
// workspace for the global sheet to cover, so each project's sheet has to
// carry the built-in defaults itself.
test("a project with no colors chosen still gets the built-in default rules", async () => {
  mount(["a", "plain"])
  await waitFor(() => expect(sheet("a")?.textContent).toContain("rgb(255 0 0 / 0.2)"))
  const plain = await waitFor(() => {
    const css = sheet("plain")?.textContent ?? ""
    expect(css).not.toBe("")
    return css
  })
  // in_progress's default (#f59e0b) and closed's (#71717a), scoped to it.
  expect(plain).toContain("rgb(245 158 11 / 0.2)")
  expect(plain).toContain("rgb(113 113 122 / 0.2)")
  for (const rule of plain.split("\n")) {
    expect(rule.startsWith('[data-project-id="plain"] ')).toBe(true)
  }
  // Still no other project's CHOSEN colour.
  expect(plain).not.toContain("255 0 0")
  expect(plain).not.toContain("0 0 255")
})

test("a project that leaves the registry drops its block", async () => {
  const view = mount(["a", "b"])
  await waitFor(() => expect(sheet("b")?.textContent).toContain("rgb(0 0 255 / 0.2)"))
  view.rerender(["a"])
  await waitFor(() => expect(sheet("b")).toBeNull())
  expect(sheet("a")?.textContent).toContain("rgb(255 0 0 / 0.2)")
})

// Fix 1 (final whole-branch review): the MutationObserver here used to
// watch only attributeFilter: ["class"], but the surface it tracks
// (--bb-card) is written to <html>'s `style` by applyTheme, never to its
// class. A style-only change -- exactly what a same-appearance theme
// switch or a hot-reloaded custom theme does -- used to leave this
// component's `surface` state stale. This mutates --bb-card with no class
// change and asserts the readable-text colour in the stylesheet actually
// follows it.
test("a style-only change to --bb-card (no class change) updates the text colour", async () => {
  document.documentElement.removeAttribute("style")
  mount(["a"])
  await waitFor(() => expect(sheet("a")?.textContent).toContain("rgb(255 0 0 / 0.2)"))
  const textColor = (css: string) => /\[data-status-role="text"\]\{color:([^}]+)\}/.exec(css)?.[1]
  const before = textColor(sheet("a")?.textContent ?? "")
  expect(before).toBeDefined()

  act(() => {
    document.documentElement.style.setProperty("--bb-card", "#ffffff")
  })

  await waitFor(() => {
    const after = textColor(sheet("a")?.textContent ?? "")
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
  })
  document.documentElement.removeAttribute("style")
})
