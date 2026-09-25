// beadbox-5yv (and z3j's option A): the app shows the PLAIN version (X.Y.Z)
// everywhere a user sees one, so promoting an rc build to the final can't ship
// a UI that says "rc.1". The build tag (e.g. 0.27.1-rc.1) stays available as a
// detail: a data attribute on the badge and the "Copy system info" line.
//
// Env is set before the component is first imported, the way a real build
// inlines it, so the badge sees the rc tag exactly as a shipped rc build does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"

const saved = { tag: process.env.VITE_BUILD_TAG, version: process.env.VITE_APP_VERSION }
let DevBadge: ComponentType
let versionModule: Record<string, unknown>

beforeAll(async () => {
  process.env.VITE_BUILD_TAG = "0.27.1-rc.1"
  process.env.VITE_APP_VERSION = "0.27.1"
  _setRpc({
    health: { getToolVersions: () => Promise.resolve({ bd_version: "1.2.2" }) },
  } as unknown as RemoteApi)
  DevBadge = (await import("../components/dev-badge")).DevBadge
  versionModule = await import("../lib/use-version")
})

afterAll(() => {
  cleanup()
  _resetRpc()
  if (saved.tag === undefined) delete process.env.VITE_BUILD_TAG
  else process.env.VITE_BUILD_TAG = saved.tag
  if (saved.version === undefined) delete process.env.VITE_APP_VERSION
  else process.env.VITE_APP_VERSION = saved.version
})

describe("plain version in the UI", () => {
  test("the always-on badge shows 0.27.1, not the rc build tag", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DevBadge />
      </QueryClientProvider>,
    )
    const badge = screen.getByTestId("dev-badge")
    expect(badge.textContent).toContain("beadbox 0.27.1 ")
    expect(badge.textContent).not.toContain("-rc.")
    // The build tag is kept as a detail for support, not as user text.
    expect(badge.getAttribute("data-build-tag")).toBe("0.27.1-rc.1")
  })

  test("the version helpers: display is plain, the build tag is separate", () => {
    const getDisplayVersion = versionModule.getDisplayVersion as (() => string) | undefined
    const getBuildTag = versionModule.getBuildTag as (() => string | null) | undefined
    expect(getDisplayVersion?.()).toBe("0.27.1")
    expect(getBuildTag?.()).toBe("0.27.1-rc.1")
  })
})
