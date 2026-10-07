// ⌘1–⌘5 for the pages without their own handler (Chart, Trains), from PR #51.

import { describe, expect, mock, test } from "bun:test"
import { tryViewSwitchShortcut } from "@/lib/view-switch-keys"

function key(k: string, init: KeyboardEventInit = { metaKey: true }) {
  return new KeyboardEvent("keydown", { key: k, cancelable: true, ...init })
}

describe("tryViewSwitchShortcut", () => {
  test("⌘1–⌘5 go to Beads, Activity, Formulas, Trains and Chart", () => {
    const routes: string[] = []
    for (const k of ["1", "2", "3", "4", "5"]) {
      tryViewSwitchShortcut(key(k), { push: (to) => routes.push(to), hasTrains: true })
    }
    expect(routes).toEqual(["/", "/activity", "/formulas", "/trains", "/chart"])
  })

  test("Ctrl works like ⌘ and the shortcut is consumed", () => {
    const push = mock()
    const e = key("5", { ctrlKey: true })
    expect(tryViewSwitchShortcut(e, { push, hasTrains: false })).toBe(true)
    expect(push).toHaveBeenCalledWith("/chart")
    expect(e.defaultPrevented).toBe(true)
  })

  test("⌘4 is consumed but goes nowhere without plans", () => {
    const push = mock()
    expect(tryViewSwitchShortcut(key("4"), { push, hasTrains: false })).toBe(true)
    expect(push).not.toHaveBeenCalled()
  })

  test("plain digits and other keys are left alone", () => {
    const push = mock()
    expect(tryViewSwitchShortcut(key("5", {}), { push, hasTrains: true })).toBe(false)
    expect(tryViewSwitchShortcut(key("6"), { push, hasTrains: true })).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })
})
