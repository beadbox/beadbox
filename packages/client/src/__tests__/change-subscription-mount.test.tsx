// Regression test for the bb-onv3.2 root cause class.
//
// THE BUG IT GUARDS AGAINST:
// routes/__root.tsx:ChangeSubscriptionMount used to derive the active
// workspace path inside a useEffect with deps [workspaces]. setWorkspaceCookie
// (called from workspaces-page.tsx handleOpen and a few other sites) only
// changes localStorage; the workspaces array reference passed by
// WorkspaceGateContext does NOT change on a switch. The effect therefore
// never re-fired on workspace switch, and useChangeSubscription stayed
// pinned to whichever path was resolved first. The change-detector polled
// the wrong workspace's database; the GUI showed stale data for any
// post-startup workspace switch.
//
// THE FIX: workspace-cookie.ts exposes subscribeWorkspaceCookie(listener)
// backed by a module-scoped EventTarget that fires from setWorkspaceCookie /
// clearWorkspaceCookie. ChangeSubscriptionMount subscribes inside the
// [workspaces] effect and re-runs the resolve() helper on every cookie
// change.
//
// THIS TEST: mounts ChangeSubscriptionMount with workspaces=[A, B] inside a
// real WorkspaceGateContext.Provider, asserts subscribe.start fires for A
// (workspaces[0] fallback when cookie unset), then calls setWorkspaceCookie
// with B's id and asserts subscribe.start fires again for B's id.
//
// Pre-fix the second assertion fails because the effect never re-fires.
// Post-fix it passes because the EventTarget pub/sub triggers resolve().

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { WorkspaceGateContext } from "../components/startup-gate"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import {
  _resetListenStderr,
  _resetRuntimeCheck,
  _setListenStderr,
  _setRuntimeCheck,
} from "../lib/subscribe"
import type { Workspace } from "../lib/types"
import {
  clearWorkspaceCookie,
  setWorkspaceCookie,
} from "../lib/workspace-cookie"
import { ChangeSubscriptionMount } from "../routes/__root"

interface RpcStartCall {
  workspacePath: string
}

let startCalls: RpcStartCall[] = []
let stopCalls: string[] = []

function installRpcMock(): void {
  startCalls = []
  stopCalls = []
  let nextId = 0
  const start = mock(async (workspacePath: string) => {
    startCalls.push({ workspacePath })
    nextId += 1
    return { id: `test-id-${nextId}` }
  })
  const stop = mock(async (id: string) => {
    stopCalls.push(id)
  })
  const trapNamespace = new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error("test rpc: unexpected namespace access")
        }
      },
    },
  )
  const fakeRpc = {
    activity: trapNamespace,
    beads: trapNamespace,
    diagnostics: trapNamespace,
    epics: trapNamespace,
    formulas: trapNamespace,
    health: trapNamespace,
    molecules: trapNamespace,
    recovery: trapNamespace,
    subscribe: { start, stop },
    system: trapNamespace,
    workspaces: trapNamespace,
  } as unknown as RemoteApi
  _setRpc(fakeRpc)
}

function installListenMock(): void {
  const unlisten = mock(() => undefined)
  const attach = mock(async (_name: string, _fn: (data: string) => void) => {
    return unlisten as unknown as () => void
  })
  _setListenStderr(attach as unknown as Parameters<typeof _setListenStderr>[0])
}

type TestWorkspace = Workspace & { databasePath: string }

function makeWorkspace(
  partial: Partial<Workspace> & Pick<Workspace, "id" | "name"> & { databasePath: string },
): TestWorkspace {
  return {
    mode: "embedded",
    ...partial,
  }
}

async function flushMicrotasks(): Promise<void> {
  // Two hops: subscribe.start Promise + listenStderrImpl Promise.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function GateProvider({
  workspaces,
  children,
}: {
  workspaces: Workspace[]
  children?: ReactNode
}): ReactNode {
  return createElement(
    WorkspaceGateContext.Provider,
    { value: { workspaces, refreshWorkspaces: () => {} } },
    children,
  )
}

let container: HTMLElement
let root: Root

describe("ChangeSubscriptionMount (bb-onv3.2 regression)", () => {
  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    _setRuntimeCheck(() => true)
    installRpcMock()
    installListenMock()
    clearWorkspaceCookie()
  })

  afterEach(() => {
    try {
      root.unmount()
    } catch {
      /* already unmounted */
    }
    if (container.parentNode) container.parentNode.removeChild(container)
    _resetRpc()
    _resetListenStderr()
    _resetRuntimeCheck()
    clearWorkspaceCookie()
  })

  test("workspace switch via setWorkspaceCookie re-fires subscribe.start", async () => {
    const workspaceA = makeWorkspace({
      id: "00000000-0000-0000-0000-aaaaaaaaaaaa",
      name: "Alpha",
      databasePath: "/tmp/alpha/.beads",
    })
    const workspaceB = makeWorkspace({
      id: "00000000-0000-0000-0000-bbbbbbbbbbbb",
      name: "Beta",
      databasePath: "/tmp/beta/.beads",
    })
    const workspaces = [workspaceA, workspaceB]

    // Initial mount: cookie unset; ChangeSubscriptionMount falls back to
    // workspaces[0].id is the subscription target.
    await act(async () => {
      root.render(
        createElement(GateProvider, { workspaces }, createElement(ChangeSubscriptionMount)),
      )
    })
    await act(async () => {
      await flushMicrotasks()
    })
    expect(startCalls.map((c) => c.workspacePath)).toEqual([workspaceA.id])

    // Switch active workspace via setWorkspaceCookie. workspaces array
    // reference is unchanged; only the cookie does. Pre-fix the effect
    // never re-fired and startCalls stayed at length 1; post-fix the
    // EventTarget triggers resolve(), activePath flips to B, and
    // useChangeSubscription's [workspacePath] deps re-fire.
    await act(async () => {
      setWorkspaceCookie(workspaceB.id)
    })
    await act(async () => {
      await flushMicrotasks()
    })

    const paths = startCalls.map((c) => c.workspacePath)
    expect(paths).toContain(workspaceA.id)
    expect(paths).toContain(workspaceB.id)
    // Beta path is the LAST start (most recent subscription).
    expect(paths[paths.length - 1]).toBe(workspaceB.id)
    // Cleanup of the Alpha id should have run.
    expect(stopCalls.length).toBeGreaterThanOrEqual(1)
  })
})
