// Task 11: wiring the stored theme preference into app startup.
//
// Covers the design in
// .superpowers/sdd/2026-11-13-runtime-themes/task-11-addendum.md: the
// theme preference is ONE observable store (local-storage.ts), not local
// state owned by this hook — so a write from any consumer (this hook, or
// usePreferences) must reach every other subscriber without a reload.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { usePreferences } from "../hooks/use-preferences"
import {
  _resetListenStderrForTheme,
  _resetRuntimeCheckForTheme,
  _setListenStderrForTheme,
  _setRuntimeCheckForTheme,
  useTheme,
} from "../hooks/use-theme"
import { useThemePreference } from "../hooks/use-theme-preference"
import {
  _resetThemePreferenceForTests,
  getThemePreference,
  setThemePreference,
  subscribeThemePreference,
} from "../lib/local-storage"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import { __resetProbeCache } from "../lib/theme-engine"
import type { ThemeEntry } from "../lib/theme-source"
import darkJson from "../themes/beadbox-dark.json"
import lightJson from "../themes/beadbox-light.json"

// useTheme() now reads useQueryClient() (task 13's hot-reload re-apply
// path), so every render needs a QueryClientProvider ancestor — a fresh
// client per render keeps tests isolated from each other's cache.
function withQuery(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

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

function SubscriptionProbe() {
  const { themeId } = useThemePreference()
  return <div data-testid="subscription-out">{themeId}</div>
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
  _resetThemePreferenceForTests()
  _resetRpc()
  _resetListenStderrForTheme()
  _resetRuntimeCheckForTheme()
})

// ─── Hot-reload test helpers (task 13) ─────────────────────────────────────

interface ThemesRpcMocks {
  list: ReturnType<typeof mock>
  get: ReturnType<typeof mock>
  startWatch: ReturnType<typeof mock>
  stopWatch: ReturnType<typeof mock>
  setEntries: (entries: ThemeEntry[]) => void
  setTheme: (id: string, theme: unknown) => void
}

/** A partial RemoteApi exposing only `themes`; any other namespace throws. */
function installThemesRpcMock(): ThemesRpcMocks {
  let entries: ThemeEntry[] = []
  const themesById = new Map<string, unknown>()

  const list = mock(async () => entries)
  const get = mock(async (id: string) => themesById.get(id) ?? null)
  const startWatch = mock(async () => undefined)
  const stopWatch = mock(async () => undefined)

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
    aggregate: trapNamespace,
    beads: trapNamespace,
    bdSettings: trapNamespace,
    console: trapNamespace,
    diagnostics: trapNamespace,
    epics: trapNamespace,
    formulas: trapNamespace,
    gates: trapNamespace,
    health: trapNamespace,
    memory: trapNamespace,
    molecules: trapNamespace,
    recovery: trapNamespace,
    session: trapNamespace,
    subscribe: trapNamespace,
    system: trapNamespace,
    themes: { list, get, startWatch, stopWatch },
    trains: trapNamespace,
    workspaces: trapNamespace,
  } as unknown as RemoteApi
  _setRpc(fakeRpc)

  return {
    list,
    get,
    startWatch,
    stopWatch,
    setEntries: (next) => {
      entries = next
    },
    setTheme: (id, theme) => {
      themesById.set(id, theme)
    },
  }
}

/** Fires a `[THEMES:changed]` stderr line once the listener has attached. */
function installThemeChangeListener(): { fire: () => void } {
  let cb: ((data: string) => void) | null = null
  const unlisten = mock(() => undefined)
  const attach = mock(async (_name: string, fn: (data: string) => void) => {
    cb = fn
    return unlisten as unknown as () => void
  })
  _setListenStderrForTheme(attach as unknown as Parameters<typeof _setListenStderrForTheme>[0])
  _setRuntimeCheckForTheme(() => true)
  return {
    fire: () => {
      if (!cb) throw new Error("theme-change listener not yet attached")
      cb(`[THEMES:changed] ${JSON.stringify({ at: Date.now() })}\n`)
    },
  }
}

describe("useTheme", () => {
  test("applies the stored theme on mount", async () => {
    localStorage.setItem("beads-theme", "beadbox-light")
    const { getByTestId } = render(withQuery(<Probe />))
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-light:true")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      lightJson.colors.background,
    )
  })

  test("defaults to the dark theme with no stored preference", async () => {
    const { getByTestId } = render(withQuery(<Probe />))
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
    const { getByTestId } = render(withQuery(<Probe />))
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
    const { getByTestId } = render(withQuery(<SetterProbe />))
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
      withQuery(
        <div>
          <Probe />
          <PreferencesProbe />
          <SubscriptionProbe />
        </div>,
      ),
    )
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
      expect(getByTestId("prefs-out").textContent).toBe("beadbox-dark")
      expect(getByTestId("subscription-out").textContent).toBe("beadbox-dark")
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
      expect(getByTestId("subscription-out").textContent).toBe("beadbox-light")
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
      const { getByTestId } = render(withQuery(<Probe />))
      await waitFor(() => {
        expect(getByTestId("out").textContent).toBe("beadbox-dark:false")
      })
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe("")
  })
})

// ─── Task 13: hot reload on file change ────────────────────────────────────
//
// Per task-13-addendum: a [THEMES:changed] stderr line (emitted by
// themes.startWatch(), see packages/server/src/handlers/themes.ts) must
// re-apply the active theme when it still validates, and must leave the
// currently applied theme untouched — not fall back to FALLBACK_THEME —
// when it no longer validates. The reason reaches the picker purely
// through the themesQueryKey invalidation (tested in settings-dialog's own
// suite); here we test the apply/no-apply decision itself.

describe("useTheme hot reload", () => {
  test("re-applies the active theme when the changed file still validates", async () => {
    localStorage.setItem("beads-theme", "custom1")
    const rpcMock = installThemesRpcMock()
    const v1 = { ...lightJson, id: "custom1", name: "Custom 1" }
    rpcMock.setTheme("custom1", v1)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "light", source: "user" }])
    const listen = installThemeChangeListener()

    const { getByTestId } = render(withQuery(<Probe />))
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("custom1:true")
      expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
        v1.colors.background,
      )
    })

    // Simulate the file being edited: still valid, different colours.
    const v2 = { ...darkJson, id: "custom1", name: "Custom 1" }
    rpcMock.setTheme("custom1", v2)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "dark", source: "user" }])

    act(() => {
      listen.fire()
    })

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
        v2.colors.background,
      )
    })
    expect(rpcMock.startWatch).toHaveBeenCalled()
  })

  test("keeps the last-good theme on screen when the changed file no longer validates", async () => {
    localStorage.setItem("beads-theme", "custom1")
    const rpcMock = installThemesRpcMock()
    const v1 = { ...lightJson, id: "custom1", name: "Custom 1" }
    rpcMock.setTheme("custom1", v1)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "light", source: "user" }])
    const listen = installThemeChangeListener()

    const { getByTestId } = render(withQuery(<Probe />))
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("custom1:true")
      expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
        v1.colors.background,
      )
    })
    const getCallsAfterMount = rpcMock.get.mock.calls.length

    // Simulate a typo saved into the file: the refreshed list now reports
    // an error for this id. The theme object behind `get` is left in place
    // on purpose — if the hook called it again despite the error, the
    // assertion below would not catch a no-op, so it must simply never be
    // called again.
    rpcMock.setEntries([
      { id: "custom1", name: "custom1", appearance: "dark", source: "user", error: "bad json" },
    ])

    act(() => {
      listen.fire()
    })

    await waitFor(() => {
      expect(rpcMock.list).toHaveBeenCalled()
    })
    // Give any (wrongly) triggered re-apply a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 50))

    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      v1.colors.background,
    )
    expect(rpcMock.get.mock.calls.length).toBe(getCallsAfterMount)
  })

  test("keeps the last-good theme on screen when the active theme's file is deleted", async () => {
    // A missing `.find()` result is `undefined`; `!undefined` is `true`,
    // so "entry absent" must be checked explicitly rather than folded into
    // `!entry?.error` alone, or a deleted file would read as "still valid"
    // and re-trigger loadTheme/applyTheme for an id the sidecar can no
    // longer serve.
    localStorage.setItem("beads-theme", "custom1")
    const rpcMock = installThemesRpcMock()
    const v1 = { ...lightJson, id: "custom1", name: "Custom 1" }
    rpcMock.setTheme("custom1", v1)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "light", source: "user" }])
    const listen = installThemeChangeListener()

    const { getByTestId } = render(withQuery(<Probe />))
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("custom1:true")
      expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
        v1.colors.background,
      )
    })
    const getCallsAfterMount = rpcMock.get.mock.calls.length

    // The file is deleted: it no longer appears in the list at all.
    rpcMock.setEntries([])

    act(() => {
      listen.fire()
    })

    await waitFor(() => {
      expect(rpcMock.list).toHaveBeenCalled()
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      v1.colors.background,
    )
    expect(rpcMock.get.mock.calls.length).toBe(getCallsAfterMount)
  })

  test("startWatch/stopWatch are not called outside a sidecar transport", async () => {
    localStorage.setItem("beads-theme", "beadbox-dark")
    const rpcMock = installThemesRpcMock()
    // No installThemeChangeListener(): runtimeCheck defaults to
    // hasSidecarTransport(), which is false under bun test.
    const { getByTestId } = render(withQuery(<Probe />))
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
    })
    expect(rpcMock.startWatch).not.toHaveBeenCalled()
  })
})
