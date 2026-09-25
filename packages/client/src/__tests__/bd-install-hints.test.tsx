// beadbox-ag1: brew is macOS-only, everywhere the client shows a bd (or
// Beadbox) install/upgrade hint outside the startup gate, which has its own
// test (startup-gate-bd-upgrade.test.tsx). Each site must name brew for
// "darwin" and for nothing else; brew as the fall-through has regressed
// four times.

import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import { DialogFooter } from "../components/update-dialog"
import { BdMissingScreen } from "../components/workspaces-page"
import { bdUpgradeHint } from "../lib/version-requirements"

afterEach(cleanup)

const GO_INSTALL =
  "CGO_ENABLED=1 GOFLAGS=-tags=gms_pure_go go install github.com/steveyegge/beads/cmd/bd@latest"
const NOT_MAC = ["linux", "win32", "freebsd", ""]

function renderMissing(platform: string) {
  return render(<BdMissingScreen onCheckAgain={() => {}} feedback={null} platform={platform} />)
}

function renderFooter(platform: string | null) {
  const noop = () => {}
  return render(
    <DialogFooter
      status="idle"
      progress={{ downloaded: 0, total: 0 }}
      progressPercent={0}
      error={null}
      platform={platform}
      isTauri={true}
      onLater={noop}
      onDismiss={noop}
      onViewOnGitHub={noop}
      onDownload={noop}
      onCancel={noop}
      onRetry={noop}
      onQuit={noop}
    />,
  )
}

describe("workspaces page: bd missing", () => {
  test("macOS gets brew install", () => {
    const { container } = renderMissing("darwin")
    expect(container.textContent).toContain("brew install beads")
  })

  test("Linux gets the documented go install and no brew", () => {
    const { container } = renderMissing("linux")
    expect(container.textContent).toContain(GO_INSTALL)
    expect(container.textContent).not.toContain("brew")
  })

  test.each(["win32", "freebsd", ""])("platform %p gets no brew", (platform) => {
    const { container } = renderMissing(platform)
    expect(container.textContent).not.toContain("brew")
  })
})

describe("update dialog footer: Homebrew cask hint", () => {
  test("macOS mentions brew upgrade --cask", () => {
    const { container } = renderFooter("darwin")
    expect(container.textContent).toContain("brew upgrade --cask beadbox")
  })

  test.each([...NOT_MAC, null])("platform %p never mentions brew", (platform) => {
    const { container } = renderFooter(platform)
    expect(container.textContent).not.toContain("brew")
  })
})

describe("client bdUpgradeHint (bd error fixes)", () => {
  test("macOS gets brew", () => {
    expect(bdUpgradeHint("darwin").fixCommand).toBe("brew upgrade beads")
  })

  test("Linux gets the documented go install", () => {
    expect(bdUpgradeHint("linux").fixCommand).toBe(GO_INSTALL)
  })

  test.each(NOT_MAC)("platform %p never gets brew", (platform) => {
    expect(JSON.stringify(bdUpgradeHint(platform))).not.toContain("brew")
  })
})
