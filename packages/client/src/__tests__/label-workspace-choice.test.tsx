import { afterEach, expect, spyOn, test } from "bun:test"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useLabelChoiceForWorkspace } from "../hooks/use-label-choice-for-workspace"
import { usePreferences } from "../hooks/use-preferences"
import { getFiltersPreference, setAnalyticsEnabled, setFiltersPreference } from "../lib/local-storage"
import * as telemetry from "../lib/posthog-safe"

const savedFilters = localStorage.getItem("beads-filters")
const savedAnalytics = localStorage.getItem("beadbox_analytics_enabled")

afterEach(() => {
  cleanup()
  for (const [key, value] of [["beads-filters", savedFilters], ["beadbox_analytics_enabled", savedAnalytics]] as const) {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  }
})

function mount(workspaceId?: string) {
  return renderHook(({ id }: { id?: string }) => {
    const prefs = usePreferences()
    useLabelChoiceForWorkspace(id, prefs.filters, prefs.setFilters)
    return prefs
  }, { initialProps: { id: workspaceId } })
}

test("legacy labels bind only once a workspace resolves, and survive the same-workspace reload", () => {
  setFiltersPreference({ ...getFiltersPreference(), labels: ["legacy"], labelsWorkspaceId: undefined })
  const view = mount()
  expect(view.result.current.filters.labels).toEqual(["legacy"])
  expect(view.result.current.filters.labelsWorkspaceId).toBeUndefined()
  view.rerender({ id: "workspace-a" })
  expect(getFiltersPreference().labelsWorkspaceId).toBe("workspace-a")
  view.unmount()
  const reloaded = mount("workspace-a")
  expect(reloaded.result.current.filters.labels).toEqual(["legacy"])
})

test("workspace switches and remounts clear only the previous workspace's label choice", () => {
  setFiltersPreference({ ...getFiltersPreference(), labels: ["private-label"], labelsWorkspaceId: "workspace-a", search: "keep-search" })
  const view = mount("workspace-a")
  view.rerender({ id: "workspace-b" })
  expect(view.result.current.filters.labels).toEqual([])
  expect(view.result.current.filters.search).toBe("keep-search")
  expect(getFiltersPreference().labelsWorkspaceId).toBe("workspace-b")
  act(() => view.result.current.setFilters({ ...view.result.current.filters, labels: ["b-label"] }))
  view.unmount()
  const remounted = mount("workspace-a")
  expect(remounted.result.current.filters.labels).toEqual([])
  expect(getFiltersPreference().labelsWorkspaceId).toBe("workspace-a")
})

test("label selection and workspace reset never send labels to filter analytics", () => {
  setAnalyticsEnabled(true)
  setFiltersPreference({ ...getFiltersPreference(), labels: [], labelsWorkspaceId: "workspace-a", assignee: "all" })
  const capture = spyOn(telemetry, "safeCapture").mockImplementation(() => {})
  try {
    const view = mount("workspace-a")
    act(() => view.result.current.setFilters({ ...view.result.current.filters, labels: ["private-customer-label"] }))
    view.rerender({ id: "workspace-b" })
    expect(capture.mock.calls).toEqual([])
    // Positive control: telemetry is enabled and the filter tracker runs.
    act(() => view.result.current.setFilters({ ...view.result.current.filters, assignee: "alice" }))
    expect(capture.mock.calls).toEqual([["app_filter_applied", { filter_type: "assignee", value: "alice" }]])
    act(() => view.result.current.setFilters({ ...view.result.current.filters, labels: ["another-private-label"] }))
    expect(capture.mock.calls).toHaveLength(1)
  } finally {
    capture.mockRestore()
  }
})
