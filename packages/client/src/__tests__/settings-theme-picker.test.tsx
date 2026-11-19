// Settings > General now
// offers a mode selector (dark / light / follow system) plus one slot grid
// per appearance, each grid listing only the themes for its own appearance
// and each grid independently keyboard-operable (its own roving tabIndex,
// so arrow keys in one grid never move focus into the other).

import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { SettingsDialog } from "../components/settings-dialog"
import {
  _resetThemePreferenceForTests,
  getThemePrefs,
  setThemeForAppearance,
} from "../lib/local-storage"
import { queryClient } from "../lib/query-client"
import { _resetRpc, _setRpc } from "../lib/rpc"
import { __resetProbeCache } from "../lib/theme-engine"
import { themesQueryKey } from "../lib/theme-source"

function renderDialog() {
  render(
    <SettingsDialog
      open
      onOpenChange={() => {}}
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
}

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

const darkGrid = () => screen.getByRole("radiogroup", { name: /dark theme/i })
const lightGrid = () => screen.getByRole("radiogroup", { name: /light theme/i })
const darkRadios = () => within(darkGrid()).getAllByRole("radio")
const lightRadios = () => within(lightGrid()).getAllByRole("radio")

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

test("renders a mode selector with dark, light and system", async () => {
  stubThemesRpc([])
  renderDialog()
  await waitFor(() => {
    expect(screen.getByRole("radio", { name: /dark mode/i })).toBeDefined()
    expect(screen.getByRole("radio", { name: /light mode/i })).toBeDefined()
    expect(screen.getByRole("radio", { name: /system/i })).toBeDefined()
  })
})

test("choosing a mode persists it", async () => {
  stubThemesRpc([])
  renderDialog()
  await waitFor(() => screen.getByRole("radio", { name: /light mode/i }))
  fireEvent.click(screen.getByRole("radio", { name: /light mode/i }))
  await waitFor(() => expect(getThemePrefs().mode).toBe("light"))
})

// The mode selector is a role="radiogroup" of three fixed options, so per
// the ARIA Authoring Practices it must use roving tabindex like the two
// ThemeSlotGrids below it: exactly one button is a Tab stop, and arrow keys
// move that stop instead of doing nothing.
test("mode selector has exactly one roving tab stop and arrow keys move it", async () => {
  stubThemesRpc([])
  renderDialog()
  await waitFor(() => screen.getByRole("radio", { name: /dark mode/i }))

  const group = screen.getByRole("radiogroup", { name: /appearance mode/i })
  const radios = () => within(group).getAllByRole("radio")

  // dark is the default mode, so it starts as the sole tab stop.
  expect(radios().filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1)
  expect(screen.getByRole("radio", { name: /dark mode/i }).getAttribute("tabindex")).toBe("0")

  fireEvent.keyDown(group, { key: "ArrowRight" })
  expect(radios().filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1)
  expect(screen.getByRole("radio", { name: /light mode/i }).getAttribute("tabindex")).toBe("0")
  expect(screen.getByRole("radio", { name: /dark mode/i }).getAttribute("tabindex")).toBe("-1")

  // Enter selects whichever button arrow keys moved focus to — the light
  // button, not the dark one still showing aria-checked.
  fireEvent.keyDown(group, { key: "Enter" })
  await waitFor(() => expect(getThemePrefs().mode).toBe("light"))
})

test("each slot grid offers only themes of its own appearance", async () => {
  stubThemesRpc([
    { id: "nord", name: "Nord", appearance: "dark", source: "user" },
    { id: "solar", name: "Solar", appearance: "light", source: "user" },
  ])
  renderDialog()

  await waitFor(() => screen.getByRole("radiogroup", { name: /dark theme/i }))
  const dark = darkGrid()
  const light = lightGrid()

  expect(within(dark).getByText("Nord")).toBeDefined()
  expect(within(dark).queryByText("Solar")).toBeNull()
  expect(within(light).getByText("Solar")).toBeDefined()
  expect(within(light).queryByText("Nord")).toBeNull()
})

test("both grids stay visible in either mode, so the inactive slot stays configurable", async () => {
  stubThemesRpc([])
  renderDialog()
  await waitFor(() => screen.getByRole("radiogroup", { name: /dark theme/i }))
  fireEvent.click(screen.getByRole("radio", { name: /light mode/i }))
  await waitFor(() => {
    expect(screen.getByRole("radiogroup", { name: /dark theme/i })).toBeDefined()
    expect(screen.getByRole("radiogroup", { name: /light theme/i })).toBeDefined()
  })
})

test("selecting in a slot writes only that slot", async () => {
  stubThemesRpc([{ id: "nord", name: "Nord", appearance: "dark", source: "user" }])
  renderDialog()
  await waitFor(() => screen.getByText("Nord"))
  fireEvent.click(screen.getByRole("radio", { name: /Nord theme/i }))
  await waitFor(() => {
    expect(getThemePrefs().darkThemeId).toBe("nord")
    expect(getThemePrefs().lightThemeId).toBe("beadbox-light")
  })
})

test("an invalid theme still shows its reason and stays unselectable, per grid", async () => {
  stubThemesRpc([
    { id: "bad", name: "Bad", appearance: "dark", source: "user", error: "colors.ring is missing" },
  ])
  renderDialog()
  await waitFor(() => expect(screen.getByText(/colors\.ring is missing/)).toBeDefined())
  const card = screen.getByRole("radio", { name: /Bad theme/i }) as HTMLButtonElement
  expect(card.disabled).toBe(true)
  fireEvent.click(card)
  await waitFor(() => expect(getThemePrefs().darkThemeId).toBe("beadbox-dark"))
})

describe("theme picker, per-grid behaviour preserved from the single-grid picker", () => {
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
    renderDialog()

    await waitFor(() => {
      expect(screen.getByText("Nord")).toBeDefined()
    })

    const nord = darkRadios().find((r) => r.getAttribute("aria-label") === "Nord theme")
    expect(nord).toBeDefined()
    expect((nord as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(nord as HTMLButtonElement)
    await waitFor(() => expect(getThemePrefs().darkThemeId).toBe("nord"))
  })

  test("keyboard: arrows move focus within a grid, Enter chooses the focused one, independently per grid", async () => {
    stubThemesRpc([
      { id: "nord", name: "Nord", appearance: "dark", source: "user" },
      { id: "solar", name: "Solar", appearance: "light", source: "user" },
    ])
    renderDialog()
    await waitFor(() => screen.getByText("Nord"))

    // Exactly one focusable card per grid before any interaction.
    expect(darkRadios().filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1)
    expect(lightRadios().filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1)

    fireEvent.keyDown(darkGrid(), { key: "ArrowRight" })
    fireEvent.keyDown(darkGrid(), { key: "Enter" })
    await waitFor(() => expect(getThemePrefs().darkThemeId).toBe("nord"))
    // Moving focus and selecting within the dark grid must not touch the
    // light slot's own (still-default) selection.
    expect(getThemePrefs().lightThemeId).toBe("beadbox-light")

    // The light grid's tab stop is untouched by the dark grid's arrow keys —
    // the two grids are independent Tab stops.
    const lightDefault = lightRadios().find(
      (r) => r.getAttribute("aria-label") === "Beadbox Light theme",
    )
    expect(lightDefault?.getAttribute("tabindex")).toBe("0")
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
    renderDialog()

    await waitFor(() => {
      expect(screen.getByText(/colors\.ring is missing/)).toBeDefined()
    })

    const bad = darkRadios().find((r) => r.getAttribute("aria-label") === "Bad Theme theme")
    expect(bad).toBeDefined()
    expect((bad as HTMLButtonElement).disabled).toBe(true)
    expect(bad?.getAttribute("aria-checked")).toBe("false")

    // Never selectable: a click on the disabled card must not choose it.
    fireEvent.click(bad as HTMLButtonElement)
    expect(getThemePrefs().darkThemeId).toBe("beadbox-dark")

    // Keyboard nav skips straight over it — focus never lands on the
    // unselectable card, however many times arrow keys are pressed.
    const group = darkGrid()
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(group, { key: "ArrowRight" })
      expect(bad?.getAttribute("tabindex")).toBe("-1")
    }
  })

  test("stored theme id is present but errored: each grid keeps a usable tab stop (not on the disabled card)", async () => {
    stubThemesRpc([
      {
        id: "errored-theme",
        name: "Errored Theme",
        appearance: "dark",
        source: "user",
        error: "invalid color format",
      },
    ])
    // The title's premise ("present but errored") requires the STORED
    // preference itself to point at the errored theme — otherwise
    // selectedId resolves to the valid default, which IS present and NOT
    // errored, and the error-fallback in settings-dialog.tsx that finds
    // the first non-errored theme never runs at all (final whole-plan
    // review, Fix 4: this test used to pass without exercising the branch
    // it names).
    setThemeForAppearance("dark", "errored-theme")
    renderDialog()

    await waitFor(() => {
      expect(screen.getByText(/invalid color format/)).toBeDefined()
    })

    const erroredCard = darkRadios().find(
      (r) => r.getAttribute("aria-label") === "Errored Theme theme",
    )
    expect(erroredCard).toBeDefined()
    expect((erroredCard as HTMLButtonElement).disabled).toBe(true)

    // The dark radiogroup must have exactly one card with tabIndex="0" for
    // keyboard accessibility. That card must NOT be disabled — a disabled
    // button is excluded from the tab order regardless of tabIndex, leaving
    // the entire radiogroup with no Tab stop at all.
    const radios = darkRadios()
    const focusableCards = radios.filter((r) => r.getAttribute("tabindex") === "0")
    expect(focusableCards).toHaveLength(1)
    expect((focusableCards[0] as HTMLButtonElement).disabled).toBe(false)

    // The errored card specifically must not hold the tab stop.
    expect(erroredCard?.getAttribute("tabindex")).toBe("-1")

    // The light grid is unaffected and keeps its own single tab stop too.
    expect(lightRadios().filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1)
  })

  // A theme whose own appearance could not
  // be recovered (unparseable JSON) must not be filed under Dark or Light
  // — it belongs in neither grid, so it renders in its own "Unknown
  // appearance" section instead.
  test("a theme with no recoverable appearance renders in its own section, not Dark or Light", async () => {
    stubThemesRpc([
      {
        id: "broken",
        name: "broken",
        appearance: null,
        source: "user",
        error: "not valid JSON: Unexpected token",
      },
    ])
    renderDialog()

    const unknownGrid = await screen.findByRole("radiogroup", { name: "Unknown appearance" })
    expect(within(unknownGrid).getByText(/not valid JSON/)).toBeDefined()

    // Neither real grid shows it or its error.
    expect(within(darkGrid()).queryByText(/not valid JSON/)).toBeNull()
    expect(within(lightGrid()).queryByText(/not valid JSON/)).toBeNull()
    expect(darkRadios().some((r) => r.getAttribute("aria-label") === "broken theme")).toBe(false)
    expect(lightRadios().some((r) => r.getAttribute("aria-label") === "broken theme")).toBe(false)
  })

  // Hot reload invalidates themesQueryKey so a changed file's
  // error (or updated preview) reaches this picker. That refetch must not
  // yank focus away from a card the user has already arrow-keyed to —
  // task-12-addendum deferred this exact tradeoff to task 13. After the
  // task 5 extraction each grid tracks this independently (its own
  // prevSyncRef), so the refetch-does-not-reset-focus guarantee is checked
  // on BOTH grids, not just whichever renders first.
  test("a themesQueryKey refetch while open does not reset arrow-key focus, in either grid", async () => {
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
        { id: "bbb", name: "Bbb", appearance: "light", source: "user" },
      ]
    })
    _setRpc({
      themes: { list, get: mock(async () => null) },
      system: { getLogDirectory: mock(async () => null) },
      bdSettings: { getBdPath: mock(async () => ({ savedPath: null })) },
    } as never)

    renderDialog()
    await waitFor(() => {
      expect(screen.getByText("Aaa")).toBeDefined()
    })

    // beadbox-dark, Aaa in the dark grid — arrow right once lands on Aaa.
    fireEvent.keyDown(darkGrid(), { key: "ArrowRight" })
    const aaa = darkRadios().find((r) => r.getAttribute("aria-label") === "Aaa theme")
    expect(aaa?.getAttribute("tabindex")).toBe("0")

    // beadbox-light, Bbb in the light grid — arrow right once lands on Bbb.
    fireEvent.keyDown(lightGrid(), { key: "ArrowRight" })
    const bbb = lightRadios().find((r) => r.getAttribute("aria-label") === "Bbb theme")
    expect(bbb?.getAttribute("tabindex")).toBe("0")

    // Simulate the hot-reload invalidation (same ids, changed preview
    // colour on Aaa) while the dialog stays open and neither slot's
    // selection changes.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: themesQueryKey })
    })
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2)
    })

    // Focus must still be on Aaa and Bbb, not reset back to the defaults,
    // in both grids independently.
    const aaaAfter = darkRadios().find((r) => r.getAttribute("aria-label") === "Aaa theme")
    expect(aaaAfter?.getAttribute("tabindex")).toBe("0")
    const darkDefaultAfter = darkRadios().find(
      (r) => r.getAttribute("aria-label") === "Beadbox Dark theme",
    )
    expect(darkDefaultAfter?.getAttribute("tabindex")).toBe("-1")

    const bbbAfter = lightRadios().find((r) => r.getAttribute("aria-label") === "Bbb theme")
    expect(bbbAfter?.getAttribute("tabindex")).toBe("0")
    const lightDefaultAfter = lightRadios().find(
      (r) => r.getAttribute("aria-label") === "Beadbox Light theme",
    )
    expect(lightDefaultAfter?.getAttribute("tabindex")).toBe("-1")
  })
})

describe("theme picker, theming unavailable", () => {
  test("explains why, instead of showing cards or a mode selector", async () => {
    __resetProbeCache()
    const original = window.getComputedStyle
    try {
      // @ts-expect-error test seam: a minimal stand-in for the probe's reads
      window.getComputedStyle = () => ({
        backgroundColor: "rgba(0, 0, 0, 0)",
        getPropertyValue: () => "",
      })
      stubThemesRpc([])
      renderDialog()
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
