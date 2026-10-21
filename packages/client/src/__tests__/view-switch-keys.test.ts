// ⌘1–⌘6 for the pages without their own handler (Chart, Trains, Waiting), from PR #51.

import { describe, expect, mock, test } from "bun:test"
import { tryViewSwitchShortcut } from "@/lib/view-switch-keys"

function key(k: string, init: KeyboardEventInit = { metaKey: true }) {
  return new KeyboardEvent("keydown", { key: k, cancelable: true, ...init })
}

describe("tryViewSwitchShortcut", () => {
  test("⌘1–⌘5 go to Beads, Activity, Formulas, Trains and Chart", () => {
    const routes: string[] = []
    for (const k of ["1", "2", "3", "4", "5"]) {
      tryViewSwitchShortcut(key(k), {
        push: (to) => routes.push(to),
        hasTrains: true,
        hasWaiting: false,
      })
    }
    expect(routes).toEqual(["/", "/activity", "/formulas", "/trains", "/chart"])
  })

  test("Ctrl works like ⌘ and the shortcut is consumed", () => {
    const push = mock()
    const e = key("5", { ctrlKey: true })
    expect(tryViewSwitchShortcut(e, { push, hasTrains: false, hasWaiting: false })).toBe(true)
    expect(push).toHaveBeenCalledWith("/chart")
    expect(e.defaultPrevented).toBe(true)
  })

  test("⌘4 is consumed but goes nowhere without plans", () => {
    const push = mock()
    const ctx = { push, hasTrains: false, hasWaiting: false }
    expect(tryViewSwitchShortcut(key("4"), ctx)).toBe(true)
    expect(push).not.toHaveBeenCalled()
  })

  test("⌘6 goes to Waiting while the workspace has an open gate", () => {
    const push = mock()
    expect(tryViewSwitchShortcut(key("6"), { push, hasTrains: false, hasWaiting: true })).toBe(true)
    expect(push).toHaveBeenCalledWith("/waiting")
  })

  test("⌘6 is consumed but goes nowhere without an open gate", () => {
    const push = mock()
    const e = key("6")
    expect(tryViewSwitchShortcut(e, { push, hasTrains: true, hasWaiting: false })).toBe(true)
    expect(push).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  test("plain digits and other keys are left alone", () => {
    const push = mock()
    const ctx = { push, hasTrains: true, hasWaiting: true }
    expect(tryViewSwitchShortcut(key("5", {}), ctx)).toBe(false)
    expect(tryViewSwitchShortcut(key("6", {}), ctx)).toBe(false)
    expect(tryViewSwitchShortcut(key("7"), ctx)).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })
})
