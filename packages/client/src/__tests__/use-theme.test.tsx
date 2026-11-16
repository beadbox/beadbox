// Task 11: wiring the stored theme preference into app startup.
//
// Covers the design in
// .superpowers/sdd/2026-11-13-runtime-themes/task-11-addendum.md: the
// theme preference is ONE observable store (local-storage.ts), not local
// state owned by this hook — so a write from any consumer (this hook, or
// usePreferences) must reach every other subscriber without a reload.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { usePreferences } from "../hooks/use-preferences"
import { useTheme } from "../hooks/use-theme"
import {
  getThemePreference,
  setThemePreference,
  subscribeThemePreference,
} from "../lib/local-storage"
import { __resetProbeCache } from "../lib/theme-engine"
import lightJson from "../themes/beadbox-light.json"

function Probe() {
  const { themeId, available } = useTheme()
  return <div data-testid="out">{`${themeId}:${available}`}</div>
}

function SetterProbe() {
  const { themeId, setTheme } = useTheme()
  return (
    <div>
      <div data-testid="setter-out">{themeId}</div>
      <button type="button" onClick={() => setTheme("beadbox-light")}>
        switch
      </button>
    </div>
  )
}

function PreferencesProbe() {
  const { theme } = usePreferences()
  return <div data-testid="prefs-out">{theme}</div>
}

beforeEach(() => {
  // isThemingAvailable is memoised across calls; without this, whichever
  // test runs first decides the verdict for every test after it.
  __resetProbeCache()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
})

describe("useTheme", () => {
  test("applies the stored theme on mount", async () => {
    localStorage.setItem("beads-theme", "beadbox-light")
    const { getByTestId } = render(<Probe />)
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-light:true")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      lightJson.colors.background,
    )
  })

  test("defaults to the dark theme with no stored preference", async () => {
    const { getByTestId } = render(<Probe />)
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  // The most important test in the file: the five-mirrors problem the
  // addendum describes would mean a change made outside this hook never
  // reaches the root that applies tokens to <html>. A local useState in
  // useTheme would pass every other test here while still shipping that
  // bug, because nothing else writes through this hook's own setTheme.
  test("a write through setThemePreference from outside the hook propagates", async () => {
    const { getByTestId } = render(<Probe />)
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
    })

    act(() => {
      setThemePreference("beadbox-light")
    })

    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-light:true")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      lightJson.colors.background,
    )
  })

  test("setTheme persists to storage and updates themeId", async () => {
    const { getByTestId } = render(<SetterProbe />)
    await waitFor(() => {
      expect(getByTestId("setter-out").textContent).toBe("beadbox-dark")
    })

    fireEvent.click(document.querySelector("button") as HTMLButtonElement)

    await waitFor(() => {
      expect(getByTestId("setter-out").textContent).toBe("beadbox-light")
    })
    expect(getThemePreference()).toBe("beadbox-light")
  })

  test("two independent subscribers both observe a change made through either", async () => {
    const { getByTestId } = render(
      <div>
        <Probe />
        <PreferencesProbe />
      </div>,
    )
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
      expect(getByTestId("prefs-out").textContent).toBe("beadbox-dark")
    })

    // Change made through the OTHER subscriber's channel (direct storage
    // write, standing in for a change made by usePreferences's
    // handleThemeChange, which also just calls setThemePreference).
    act(() => {
      setThemePreference("beadbox-light")
    })

    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-light:true")
      expect(getByTestId("prefs-out").textContent).toBe("beadbox-light")
    })
  })

  test("subscribeThemePreference's unsubscribe actually detaches", () => {
    let calls = 0
    const unsubscribe = subscribeThemePreference(() => {
      calls++
    })
    setThemePreference("beadbox-light")
    expect(calls).toBe(1)

    unsubscribe()
    setThemePreference("beadbox-dark")
    expect(calls).toBe(1)
  })

  test("writes no --bb-* property when theming is unavailable", async () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = () => {
      throw new Error("Simulated engine failure")
    }
    try {
      const { getByTestId } = render(<Probe />)
      await waitFor(() => {
        expect(getByTestId("out").textContent).toBe("beadbox-dark:false")
      })
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe("")
  })
})
