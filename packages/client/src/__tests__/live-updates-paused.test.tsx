// beadbox-01f.2: "live updates paused" must be visible (it used to reach only
// the dev console) and its Refresh must reload the view on its own.

import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { LiveUpdatesPausedBanner } from "../components/live-updates-paused"
import {
  _getSubscriptionChangeCount,
  _resetLiveUpdatesPaused,
  _resetSubscriptionChangeCount,
  _setLiveUpdatesPausedForTests,
} from "../lib/subscribe"

afterEach(() => {
  cleanup()
  _resetLiveUpdatesPaused()
  _resetSubscriptionChangeCount()
})

describe("LiveUpdatesPausedBanner", () => {
  test("renders nothing while live updates are flowing", () => {
    render(<LiveUpdatesPausedBanner />)
    expect(screen.queryByText("Live updates paused.")).toBeNull()
  })

  test("shows the paused state with a Refresh that reloads the view", () => {
    render(<LiveUpdatesPausedBanner />)
    act(() => _setLiveUpdatesPausedForTests(true))
    expect(screen.getByText("Live updates paused.")).toBeTruthy()
    const before = _getSubscriptionChangeCount()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(_getSubscriptionChangeCount()).toBe(before + 1)
  })

  test("clears when live updates recover", () => {
    render(<LiveUpdatesPausedBanner />)
    act(() => _setLiveUpdatesPausedForTests(true))
    act(() => _resetLiveUpdatesPaused())
    expect(screen.queryByText("Live updates paused.")).toBeNull()
  })
})
