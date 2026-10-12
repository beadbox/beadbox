// beadbox-d0d (GitHub #55): CopyableId shows an id that fits its budget and
// copies the FULL id whatever it shows.

import { afterEach, expect, test } from "bun:test"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CopyableId } from "../components/copyable-id"

const LONG = "longprefixab-a1b2c3.12.7" // 24 chars
const SHORT = "bb-a1b2c3"

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
afterEach(() => {
  cleanup()
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
})

function shown(): string {
  return screen.getByRole("button").textContent ?? ""
}

test("a long id shows at most 14 characters by default, never the old 17", () => {
  render(<CopyableId id={LONG} />)
  expect(shown().length).toBeLessThanOrEqual(14)
  expect(shown()).not.toBe(LONG)
})

test("the epic row's budget (13) is honoured", () => {
  render(<CopyableId id={LONG} maxChars={13} />)
  expect(shown()).toBe("longpr…3.12.7")
})

test("an id that fits is shown in full", () => {
  render(<CopyableId id={SHORT} maxChars={13} />)
  expect(shown()).toBe(SHORT)
})

test("copy uses the full id, not the shortened form (AC3)", async () => {
  const written: string[] = []
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (t: string) => void written.push(t) },
  })
  render(<CopyableId id={LONG} maxChars={13} />)
  fireEvent.click(screen.getByRole("button"))
  await waitFor(() => expect(written).toEqual([LONG]))
})
