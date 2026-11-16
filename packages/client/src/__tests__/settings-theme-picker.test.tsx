// beadbox-knr: Settings > General offers every built-in theme, in the
// packaged runtime and in the browser alike; a stored id that isn't
// currently installed (an uninstalled theme, or a legacy "gray"/"blue"/
// "green" preference from before runtime themes) shows the default theme
// selected without the stored preference itself being rewritten; the picker
// stays keyboard-operable.

import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { SettingsDialog } from "../components/settings-dialog"
import {
  _resetThemePreferenceForTests,
  getThemePreference,
  setThemePreference,
  type ThemeId,
} from "../lib/local-storage"
import { queryClient } from "../lib/query-client"
import { _resetRpc, _setRpc } from "../lib/rpc"
import { __resetProbeCache } from "../lib/theme-engine"
import { themesQueryKey } from "../lib/theme-source"

function renderDialog(theme: ThemeId, onThemeChange = mock(() => {})) {
  render(
    <SettingsDialog
      open
      onOpenChange={() => {}}
      theme={theme}
      onThemeChange={onThemeChange}
      zoomLevel={100}
      onZoomChange={() => {}}
      vimNavigationEnabled
      onVimNavigationChange={() => {}}
      updateCheckEnabled
      onUpdateCheckEnabledChange={() => {}}
      updateCheckFrequency={3600000}
      onUpdateCheckFrequencyChange={() => {}}
      updateAvailable={null}
      updateChecking={false}
      updateCheckError={null}
      onCheckForUpdates={async () => {}}
    />,
  )
  return onThemeChange
}

const themeRadios = () =>
  within(screen.getByRole("radiogroup", { name: "Theme selection" })).getAllByRole("radio")

// _setRpc replaces the whole RemoteApi, not just the namespace under test —
// unlike _resetRpc's default stub, it leaves every other namespace
// `undefined`. SettingsDialogContent calls rpc.system.getLogDirectory()
// unconditionally on open (and BdPathSettings, mounted alongside the theme
// picker, calls rpc.bdSettings.getBdPath()), so a themes-only mock throws a
// synchronous TypeError before the picker ever renders. Stub those two too.
const stubThemesRpc = (list: unknown[]) =>
  _setRpc({
    themes: { list: mock(async () => list), get: mock(async () => null) },
    system: { getLogDirectory: mock(async () => null) },
    bdSettings: { getBdPath: mock(async () => ({ savedPath: null })) },
  } as never)

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  _resetThemePreferenceForTests()
  _resetRpc()
  queryClient.clear()
  // The engine-support probe is memoised at module scope (theme-engine.ts),
  // so a test that forces "unavailable" must not leak that into tests that
  // run afterwards in this same process.
  __resetProbeCache()
})

for (const runtime of ["packaged", "browser"] as const) {
  describe(`theme picker, ${runtime} runtime`, () => {
    const setRuntime = () => {
      if (runtime === "packaged")
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    }

    test("offers both built-in themes", () => {
      setRuntime()
      renderDialog("beadbox-dark")
      expect(themeRadios().map((r) => r.getAttribute("aria-label"))).toEqual([
        "Beadbox Dark theme",
        "Beadbox Light theme",
      ])
    })

    test("a stored unknown theme id shows the default selected", () => {
      setRuntime()
      renderDialog("nord")
      const [dark] = themeRadios()
      expect(dark.getAttribute("aria-label")).toBe("Beadbox Dark theme")
      expect(dark.getAttribute("aria-checked")).toBe("true")
    })

    test("an unresolved preference is displayed, not rewritten", () => {
      setRuntime()
      setThemePreference("nord")
      renderDialog("nord")
      expect(getThemePreference()).toBe("nord")
    })

    test("keyboard: arrows move focus between themes, Enter chooses the focused one", () => {
      setRuntime()
      const onThemeChange = renderDialog("beadbox-dark")
      const group = screen.getByRole("radiogroup", { name: "Theme selection" })
      fireEvent.keyDown(group, { key: "ArrowRight" })
      fireEvent.keyDown(group, { key: "Enter" })
      expect(onThemeChange).toHaveBeenCalledTimes(1)
      expect(onThemeChange).toHaveBeenCalledWith("beadbox-light")
    })
  })
}

describe("theme picker, user themes", () => {
  test("a user theme's preview colours drive its card, and it is selectable", async () => {
    stubThemesRpc([
      {
        id: "nord",
        name: "Nord",
        appearance: "dark",
        source: "user",
        preview: {
          background: "#2e3440",
          card: "#3b4252",
          primary: "#88c0d0",
          secondary: "#434c5e",
          mutedForeground: "#d8dee9",
          foreground: "#eceff4",
        },
      },
    ])
    const onThemeChange = renderDialog("beadbox-dark")

    await waitFor(() => {
      expect(screen.getByText("Nord")).toBeDefined()
    })

    const nord = themeRadios().find((r) => r.getAttribute("aria-label") === "Nord theme")
    expect(nord).toBeDefined()
    expect((nord as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(nord as HTMLButtonElement)
    expect(onThemeChange).toHaveBeenCalledWith("nord")
  })

  // Task 12's placeholder -> resolved-list transition: the picker renders
  // BUILTIN_ENTRIES synchronously before the sidecar's list resolves, so
  // the stored theme's own card is not even in the DOM on first render.
  // The focus-sync fix added in task 13 (resync only on open/theme/id-list
  // change, not on every themesQueryKey refetch) must still catch THIS
  // transition — the id list goes from [dark, light] to [dark, light,
  // nord] — or a stored user-theme preference would be left with the tab
  // stop stuck on Beadbox Dark despite Nord being the checked radio.
  test("the tab stop moves onto a stored user theme once the placeholder resolves", async () => {
    stubThemesRpc([
      {
        id: "nord",
        name: "Nord",
        appearance: "dark",
        source: "user",
        preview: {
          background: "#2e3440",
          card: "#3b4252",
          primary: "#88c0d0",
          secondary: "#434c5e",
          mutedForeground: "#d8dee9",
          foreground: "#eceff4",
        },
      },
    ])
    renderDialog("nord")

    await waitFor(() => {
      expect(screen.getByText("Nord")).toBeDefined()
    })

    const nord = themeRadios().find((r) => r.getAttribute("aria-label") === "Nord theme")
    expect(nord?.getAttribute("aria-checked")).toBe("true")
    expect(nord?.getAttribute("tabindex")).toBe("0")
    const dark = themeRadios().find((r) => r.getAttribute("aria-label") === "Beadbox Dark theme")
    expect(dark?.getAttribute("tabindex")).toBe("-1")
  })

  test("shows an invalid user theme's error instead of hiding it, and keyboard nav skips it", async () => {
    stubThemesRpc([
      {
        id: "bad",
        name: "Bad Theme",
        appearance: "dark",
        source: "user",
        error: "colors.ring is missing",
      },
    ])
    const onThemeChange = renderDialog("beadbox-dark")

    await waitFor(() => {
      expect(screen.getByText(/colors\.ring is missing/)).toBeDefined()
    })

    const bad = themeRadios().find((r) => r.getAttribute("aria-label") === "Bad Theme theme")
    expect(bad).toBeDefined()
    expect((bad as HTMLButtonElement).disabled).toBe(true)
    expect(bad?.getAttribute("aria-checked")).toBe("false")

    // Never selectable: a click on the disabled card must not choose it.
    fireEvent.click(bad as HTMLButtonElement)
    expect(onThemeChange).not.toHaveBeenCalled()

    // Keyboard nav skips straight over it — focus never lands on the
    // unselectable card, however many times arrow keys are pressed.
    const group = screen.getByRole("radiogroup", { name: "Theme selection" })
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(group, { key: "ArrowRight" })
      expect(bad?.getAttribute("tabindex")).toBe("-1")
    }
  })

  test("stored theme id is present but errored: radiogroup has a usable tab stop (not on the disabled card)", async () => {
    stubThemesRpc([
      {
        id: "errored-theme",
        name: "Errored Theme",
        appearance: "dark",
        source: "user",
        error: "invalid color format",
      },
    ])
    renderDialog("errored-theme")

    await waitFor(() => {
      expect(screen.getByText(/invalid color format/)).toBeDefined()
    })

    const erroredCard = themeRadios().find(
      (r) => r.getAttribute("aria-label") === "Errored Theme theme",
    )
    expect(erroredCard).toBeDefined()
    expect((erroredCard as HTMLButtonElement).disabled).toBe(true)

    // The radiogroup must have exactly one card with tabIndex="0" for keyboard
    // accessibility. That card must NOT be disabled — a disabled button is
    // excluded from the tab order regardless of tabIndex, leaving the entire
    // radiogroup with no Tab stop at all.
    const radios = themeRadios()
    const focusableCards = radios.filter((r) => r.getAttribute("tabindex") === "0")
    expect(focusableCards).toHaveLength(1)
    expect((focusableCards[0] as HTMLButtonElement).disabled).toBe(false)

    // The errored card specifically must not hold the tab stop.
    expect(erroredCard?.getAttribute("tabindex")).toBe("-1")
  })

  // Task 13: hot reload invalidates themesQueryKey so a changed file's
  // error (or updated preview) reaches this picker. That refetch must not
  // yank focus away from a card the user has already arrow-keyed to —
  // task-12-addendum deferred this exact tradeoff to task 13.
  test("a themesQueryKey refetch while open does not reset arrow-key focus", async () => {
    let round = 0
    const list = mock(async () => {
      round++
      return [
        {
          id: "aaa",
          name: "Aaa",
          appearance: "dark",
          source: "user",
          preview: {
            background: "#000000",
            card: "#111111",
            primary: round === 1 ? "#88c0d0" : "#99d1e1",
            secondary: "#222222",
            mutedForeground: "#333333",
            foreground: "#eceff4",
          },
        },
      ]
    })
    _setRpc({
      themes: { list, get: mock(async () => null) },
      system: { getLogDirectory: mock(async () => null) },
      bdSettings: { getBdPath: mock(async () => ({ savedPath: null })) },
    } as never)

    renderDialog("beadbox-dark")
    await waitFor(() => {
      expect(screen.getByText("Aaa")).toBeDefined()
    })

    const group = screen.getByRole("radiogroup", { name: "Theme selection" })
    // beadbox-dark, beadbox-light, Aaa — arrow right twice lands on Aaa.
    fireEvent.keyDown(group, { key: "ArrowRight" })
    fireEvent.keyDown(group, { key: "ArrowRight" })
    const aaa = themeRadios().find((r) => r.getAttribute("aria-label") === "Aaa theme")
    expect(aaa?.getAttribute("tabindex")).toBe("0")

    // Simulate the hot-reload invalidation (same id, changed preview
    // colour) while the dialog stays open and the selected theme (prop
    // `theme`) is unchanged.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: themesQueryKey })
    })
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2)
    })

    // Focus must still be on Aaa, not reset back to beadbox-dark.
    const aaaAfter = themeRadios().find((r) => r.getAttribute("aria-label") === "Aaa theme")
    expect(aaaAfter?.getAttribute("tabindex")).toBe("0")
    const darkAfter = themeRadios().find(
      (r) => r.getAttribute("aria-label") === "Beadbox Dark theme",
    )
    expect(darkAfter?.getAttribute("tabindex")).toBe("-1")
  })
})

describe("theme picker, theming unavailable", () => {
  test("explains why, instead of showing cards", async () => {
    __resetProbeCache()
    const original = window.getComputedStyle
    try {
      // @ts-expect-error test seam: a minimal stand-in for the probe's reads
      window.getComputedStyle = () => ({
        backgroundColor: "rgba(0, 0, 0, 0)",
        getPropertyValue: () => "",
      })
      renderDialog("beadbox-dark")
      await waitFor(() => {
        expect(screen.getByText(/not supported/i)).toBeDefined()
      })
      expect(screen.queryAllByRole("radio")).toHaveLength(0)
    } finally {
      window.getComputedStyle = original
      __resetProbeCache()
    }
  })
})
