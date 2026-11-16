// beadbox-knr: Settings > General offers every built-in theme, in the
// packaged runtime and in the browser alike; a stored id that isn't
// currently installed (an uninstalled theme, or a legacy "gray"/"blue"/
// "green" preference from before runtime themes) shows the default theme
// selected without the stored preference itself being rewritten; the picker
// stays keyboard-operable.

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { SettingsDialog } from "../components/settings-dialog"
import {
  _resetThemePreferenceForTests,
  getThemePreference,
  setThemePreference,
  type ThemeId,
} from "../lib/local-storage"

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

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  _resetThemePreferenceForTests()
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
