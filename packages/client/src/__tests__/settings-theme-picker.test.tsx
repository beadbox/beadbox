// beadbox-knr: Settings > General offers only the theme that can render
// (Gray), in the packaged runtime and in the browser alike; a stored Blue or
// Green shows Gray selected; the picker stays keyboard-operable.

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { SettingsDialog } from "../components/settings-dialog"
import type { ThemeVariant } from "../lib/local-storage"

function renderDialog(theme: ThemeVariant, onThemeChange = mock(() => {})) {
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

const themeRadios = () => within(screen.getByRole("radiogroup", { name: "Theme selection" })).getAllByRole("radio")

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

for (const runtime of ["packaged", "browser"] as const) {
  describe(`theme picker, ${runtime} runtime`, () => {
    const setRuntime = () => {
      if (runtime === "packaged") (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    }

    test("offers exactly one theme, Gray", () => {
      setRuntime()
      renderDialog("gray")
      expect(themeRadios().map((r) => r.getAttribute("aria-label"))).toEqual(["Gray theme"])
    })

    test("a stored blue shows Gray selected", () => {
      setRuntime()
      renderDialog("blue")
      const [gray] = themeRadios()
      expect(gray.getAttribute("aria-label")).toBe("Gray theme")
      expect(gray.getAttribute("aria-checked")).toBe("true")
    })

    test("keyboard: arrows stay on Gray, Enter chooses Gray", () => {
      setRuntime()
      const onThemeChange = renderDialog("green")
      const group = screen.getByRole("radiogroup", { name: "Theme selection" })
      fireEvent.keyDown(group, { key: "ArrowRight" })
      fireEvent.keyDown(group, { key: "ArrowLeft" })
      fireEvent.keyDown(group, { key: "Enter" })
      expect(onThemeChange).toHaveBeenCalledTimes(1)
      expect(onThemeChange).toHaveBeenCalledWith("gray")
    })
  })
}
