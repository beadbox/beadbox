// beadbox-z04: past the reload cap the host navigates to the app's own page
// with `stopped=1`, and the client renders only the plain message there.

import { afterEach, expect, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { isStoppedPage, STOPPED_PAGE_MESSAGE, StoppedPage } from "../components/stopped-page"

afterEach(() => cleanup())

test("the host's stopped URL is recognised; the normal app URL is not", () => {
  // The exact query the Rust side produces (stopped_page_url in src-tauri/src/lib.rs).
  expect(isStoppedPage("?sidecar=1&stopped=1")).toBe(true)
  expect(isStoppedPage("?sidecar=1")).toBe(false)
  expect(isStoppedPage("")).toBe(false)
  expect(isStoppedPage("?stopped=0")).toBe(false)
})

test("the stopped page shows the plain message and nothing else", () => {
  render(<StoppedPage />)
  expect(STOPPED_PAGE_MESSAGE).toBe("Beadbox's page stopped responding. Quit and reopen Beadbox.")
  expect(screen.getByText(STOPPED_PAGE_MESSAGE)).toBeTruthy()
  expect(screen.queryAllByRole("button")).toHaveLength(0)
})
