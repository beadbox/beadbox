// Fix 1 (final whole-branch review, 2026-11-13 runtime-themes): the
// MutationObserver in StatusColorsMount used to watch only
// attributeFilter: ["class"]. currentThemeSurface() reads the --bb-card
// custom property, which applyTheme writes to the element's `style`, not
// its class -- so a theme change that doesn't flip the class (dark -> dark,
// light -> light, or hot-reloading a custom theme's card colour in place)
// never reached the observer, leaving statusColorStore's surface stale.
//
// This test writes --bb-card directly onto <html>'s style with NO class
// change, which is exactly what applyTheme does on a same-appearance
// switch or a hot reload. Pre-fix this never fires; post-fix it does.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { WorkspaceGateContext } from "../components/startup-gate"
import { StatusColorsMount } from "../components/status-colors-mount"
import { statusColorStore } from "../lib/status-colors-store"

function mountWithEmptyGate() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceGateContext.Provider value={{ workspaces: [], refreshWorkspaces: () => {} }}>
        <StatusColorsMount />
      </WorkspaceGateContext.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  statusColorStore._reset()
})

afterEach(() => {
  cleanup()
  statusColorStore._reset()
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
})

describe("StatusColorsMount surface observer", () => {
  test("a style-only change to --bb-card, with no class change, updates the stored surface", async () => {
    mountWithEmptyGate()
    // Baseline: nothing set yet, so the store holds the gray-card fallback.
    await waitFor(() => expect(statusColorStore.get().surface).toBe("#27272a"))

    // The hot-reload / same-appearance case: applyTheme writes the new
    // card colour onto style without ever touching the class attribute.
    act(() => {
      document.documentElement.style.setProperty("--bb-card", "#654321")
    })

    await waitFor(() => expect(statusColorStore.get().surface).toBe("#654321"))
  })
})
