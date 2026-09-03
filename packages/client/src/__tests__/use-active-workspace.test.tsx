// useActiveWorkspace + useWorkspaceLabelSync — the resolution contract the
// activity and formulas routes depend on.
//
// Both routes hold a workspace list and no epic lifecycle, so this hook is
// the only thing that notices a rail switch (StartupGate does not remount
// them for an already-verified workspace) or a rail rename.

import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, render, screen } from "@testing-library/react"

import { useActiveWorkspace } from "../hooks/use-active-workspace"
import type { Workspace } from "../lib/types"
import { clearWorkspaceCookie, setWorkspaceCookie } from "../lib/workspace-cookie"
import { publishWorkspaceLabel } from "../lib/workspace-labels"

const alpha: Workspace = {
  id: "id-alpha",
  name: "alpha",
  path: "/tmp/alpha",
  databasePath: "/tmp/alpha/.beads",
  mode: "embedded",
}

const beta: Workspace = {
  id: "id-beta",
  name: "beta",
  path: "/tmp/beta",
  databasePath: "/tmp/beta/.beads",
  mode: "embedded",
}

function Probe({ workspaces }: { workspaces: Workspace[] }) {
  const [active] = useActiveWorkspace(workspaces)
  return (
    <span data-testid="active">{`${active?.id ?? "none"}|${active?.name ?? ""}|${active?.icon ?? ""}`}</span>
  )
}

const activeText = () => screen.getByTestId("active").textContent

afterEach(() => {
  cleanup()
  clearWorkspaceCookie()
})

describe("useActiveWorkspace", () => {
  test("resolves from the cookie, falling back to the first workspace", () => {
    setWorkspaceCookie(beta.id)
    render(<Probe workspaces={[alpha, beta]} />)
    expect(activeText()).toBe("id-beta|beta|")

    cleanup()
    clearWorkspaceCookie()
    render(<Probe workspaces={[alpha, beta]} />)
    expect(activeText()).toBe("id-alpha|alpha|")
  })

  test("re-resolves when the cookie changes without a remount", () => {
    setWorkspaceCookie(alpha.id)
    render(<Probe workspaces={[alpha, beta]} />)

    act(() => {
      setWorkspaceCookie(beta.id)
    })
    expect(activeText()).toBe("id-beta|beta|")
  })

  test("keeps the current workspace when the cookie points at an unknown id", () => {
    setWorkspaceCookie(beta.id)
    render(<Probe workspaces={[alpha, beta]} />)

    act(() => {
      setWorkspaceCookie("id-unregistered")
    })
    // Not a silent jump to workspaces[0].
    expect(activeText()).toBe("id-beta|beta|")

    act(() => {
      clearWorkspaceCookie()
    })
    expect(activeText()).toBe("id-beta|beta|")
  })

  test("adopts a published label change for the active workspace", () => {
    setWorkspaceCookie(alpha.id)
    render(<Probe workspaces={[alpha, beta]} />)

    act(() => {
      publishWorkspaceLabel({ workspaceId: alpha.id, name: "Alpha prod", icon: "🚀" })
    })
    expect(activeText()).toBe("id-alpha|Alpha prod|🚀")

    // A change for another workspace must not touch the active one.
    act(() => {
      publishWorkspaceLabel({ workspaceId: beta.id, name: "Beta prod" })
    })
    expect(activeText()).toBe("id-alpha|Alpha prod|🚀")
  })
})
