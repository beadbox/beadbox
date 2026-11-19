// ui/sonner.tsx hardcoded `theme="dark"` through the whole runtime-themes
// build, which left the toast's INTERNAL chrome (close button, description
// text) dark-tuned on a light theme. Those colours live inside the library
// and are not exposed as variables, so the palette sweep could not reach
// them — only the `theme` prop can. It now takes the resolved appearance.
//
// Sonner renders its themed <ol> only once a toast exists, so each case fires
// one; asserting on an empty <Toaster /> would pass against nothing.
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, render } from "@testing-library/react"
import { toast } from "sonner"
import { Toaster } from "../components/ui/sonner"
import { clearCache } from "../lib/local-storage"

afterEach(() => {
  cleanup()
  localStorage.clear()
  clearCache()
})

async function mountWith(mode: "dark" | "light"): Promise<HTMLElement> {
  // clearCache FIRST: it removes the stored keys and drops the in-memory
  // prefs, so seeding before it would wipe exactly what we just wrote.
  clearCache()
  localStorage.setItem(
    "beads-theme-prefs",
    JSON.stringify({ mode, darkThemeId: "beadbox-dark", lightThemeId: "beadbox-light" }),
  )
  render(<Toaster />)
  await act(async () => {
    toast("hello")
    await new Promise((r) => setTimeout(r, 60))
  })
  const el = document.querySelector<HTMLElement>("[data-sonner-toaster]")
  if (!el) throw new Error("sonner toaster did not render")
  return el
}

describe("Toaster follows the resolved appearance", () => {
  test("light mode renders a light-themed toaster", async () => {
    expect((await mountWith("light")).getAttribute("data-theme")).toBe("light")
  })

  test("dark mode renders a dark-themed toaster", async () => {
    expect((await mountWith("dark")).getAttribute("data-theme")).toBe("dark")
  })

  // The regression guard: hardcoding the prop again makes these equal, and
  // no single-appearance assertion above would notice.
  test("the two appearances differ", async () => {
    const light = (await mountWith("light")).getAttribute("data-theme")
    cleanup()
    const dark = (await mountWith("dark")).getAttribute("data-theme")
    expect(dark).not.toBe(light)
  })

  test("the toast body still resolves through the --bb-* tokens", async () => {
    const style = (await mountWith("light")).getAttribute("style") ?? ""
    expect(style).toContain("var(--bb-popover)")
    expect(style).toContain("var(--bb-popover-foreground)")
    expect(style).toContain("var(--bb-border)")
  })
})
