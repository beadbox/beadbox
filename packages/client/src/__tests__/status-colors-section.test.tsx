// beadbox-o3h QA bounce: the Status colors rows in Settings > Workflow.
// Focus alone must choose nothing, and a late reply to an older save must
// never roll back a newer change.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

import { statusColorsQueryKey } from "../components/status-colors-mount"
import { StatusColorsSection } from "../components/status-colors-section"
import { queryClient } from "../lib/query-client"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import { statusColorStore } from "../lib/status-colors-store"

let setStatusColors: ReturnType<typeof mock>

beforeEach(() => {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
  setStatusColors = mock(async (_id: string, colors: Record<string, string> | null) => ({
    success: true,
    colors: colors ?? {},
  }))
  _setRpc({ workspaces: { setStatusColors } } as unknown as RemoteApi)
  statusColorStore.set({
    workspaceId: "ws-1",
    statuses: ["open", "in_progress", "closed", "waiting_on_nelson"],
    customs: ["waiting_on_nelson"],
    overrides: {},
  })
})

afterEach(() => {
  cleanup()
  _resetRpc()
  statusColorStore._reset()
  queryClient.clear()
})

const hexField = (label: string) => screen.getByRole("textbox", { name: `${label} color hex` })

describe("StatusColorsSection", () => {
  test("focusing and leaving a field without typing chooses nothing", async () => {
    render(<StatusColorsSection customStatuses={["waiting_on_nelson"]} />)
    for (const label of ["Open", "In Progress", "Closed", "Waiting On Nelson"]) {
      const field = hexField(label)
      fireEvent.focus(field)
      fireEvent.blur(field)
    }
    await new Promise((r) => setTimeout(r, 400))
    expect(statusColorStore.get().overrides).toEqual({})
    expect(setStatusColors).not.toHaveBeenCalled()
  })

  test("an invalid draft left on blur reverts, and saves nothing", async () => {
    render(<StatusColorsSection customStatuses={["waiting_on_nelson"]} />)
    const field = hexField("Open") as HTMLInputElement
    fireEvent.change(field, { target: { value: "#zz" } })
    fireEvent.blur(field)
    await new Promise((r) => setTimeout(r, 400))
    expect(field.value).toBe("#ffffff")
    expect(setStatusColors).not.toHaveBeenCalled()
  })

  test("blur after typing a new value saves it", async () => {
    render(<StatusColorsSection customStatuses={["waiting_on_nelson"]} />)
    const field = hexField("Open")
    fireEvent.change(field, { target: { value: "#ff0000" } })
    fireEvent.blur(field)
    expect(statusColorStore.get().overrides).toEqual({ open: "#ff0000" })
  })

  test("a slow save's response never rolls back a newer change (out-of-order replies)", async () => {
    // Each save resolves only when released, so replies can arrive late.
    const pending: Array<() => void> = []
    setStatusColors.mockImplementation(
      (_id: string, colors: Record<string, string> | null) =>
        new Promise((resolve) => pending.push(() => resolve({ success: true, colors: colors ?? {} }))),
    )
    render(<StatusColorsSection customStatuses={["waiting_on_nelson"]} />)
    for (const [label, hex] of [
      ["Open", "#ff0000"],
      ["Closed", "#00ff00"],
    ]) {
      const field = hexField(label)
      fireEvent.change(field, { target: { value: hex } })
      fireEvent.keyDown(field, { key: "Enter" })
    }
    expect(pending.length).toBe(2)
    // The newer save answers first, then the older one.
    await act(async () => {
      pending[1]()
      pending[0]()
      await new Promise((r) => setTimeout(r, 0))
    })
    // The cache the mount feeds back into the store holds the latest map.
    expect(queryClient.getQueryData<Record<string, string>>(statusColorsQueryKey("ws-1"))).toEqual({ open: "#ff0000", closed: "#00ff00" })
    expect(statusColorStore.get().overrides).toEqual({ open: "#ff0000", closed: "#00ff00" })
  })
})
