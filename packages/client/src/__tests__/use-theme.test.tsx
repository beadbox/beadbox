// Task 11: wiring the stored theme preference into app startup.
//
// Covers the design in
// .superpowers/sdd/2026-11-13-runtime-themes/task-11-addendum.md: the
// theme preference is ONE observable store (local-storage.ts), not local
// state owned by this hook — so a write from any consumer (this hook, or
// usePreferences) must reach every other subscriber without a reload.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { SettingsDialog } from "../components/settings-dialog"
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
import { queryClient } from "../lib/query-client"
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
  // Only the Fix 5 integration test below touches the real singleton
  // client (it mounts SettingsDialog, which self-wraps with it); clearing
  // unconditionally keeps that test from leaking cached entries into
  // settings-theme-picker.test.tsx's own suite.
  queryClient.clear()
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

  // Fix 1 (sidecar restart): the new process boots with
  // packages/server/src/handlers/themes.ts's stopWatcher back at null, and
  // nothing re-arms the watch unless the client calls startWatch() again
  // against the new process. lib/rpc.ts dispatches "beadbox:sidecar-exit"
  // for exactly this; the watcher effect must re-run on it, mirroring
  // lib/subscribe.ts's transportEpoch.
  test("re-subscribes (startWatch again) after a beadbox:sidecar-exit event", async () => {
    localStorage.setItem("beads-theme", "beadbox-dark")
    const rpcMock = installThemesRpcMock()
    rpcMock.setEntries([])
    installThemeChangeListener()

    const { getByTestId } = render(withQuery(<Probe />))
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
    })
    await waitFor(() => {
      expect(rpcMock.startWatch).toHaveBeenCalledTimes(1)
    })

    act(() => {
      window.dispatchEvent(new Event("beadbox:sidecar-exit"))
    })

    await waitFor(() => {
      expect(rpcMock.startWatch).toHaveBeenCalledTimes(2)
    })
  })

  // Fix 2 (the race leaves the app stuck on dark, not merely flashing): the
  // watcher's list refetch can still find the active theme valid (so the
  // epoch bumps) while a SECOND, invalid save has already landed on disk by
  // the time loadTheme actually reads the file — rpc.themes.get now returns
  // something that fails validateTheme, so loadTheme collapses to
  // FALLBACK_THEME. The apply effect must refuse that result rather than
  // applying it, or the app would be stranded on Beadbox Dark until the
  // file becomes valid again.
  test("a hot-reload re-apply that resolves the fallback theme leaves the on-screen theme untouched", async () => {
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

    // The list still reports custom1 as valid (stillValid -> epoch bumps),
    // but the file behind `get` is now broken — the exact race window Fix 2
    // targets. The list entry is deliberately left without `.error`: that
    // is what makes the watcher think the theme is still good.
    rpcMock.setTheme("custom1", { ...v1, appearance: undefined })

    act(() => {
      listen.fire()
    })

    // Give the (wrongly) applied fallback a chance to land before asserting
    // its absence — this is an absence assertion, which cannot be polled for.
    await new Promise((r) => setTimeout(r, 50))

    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      v1.colors.background,
    )
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  // Fix 2's critical constraint: the guard above must apply ONLY to
  // epoch-triggered re-applies, never to the initial apply — startup has no
  // last-good theme to protect, so falling back to the bundled dark theme
  // there is correct, already-tested behaviour that Fix 2 must not disturb.
  test("startup still falls back to the bundled dark theme when the stored theme fails validation", async () => {
    localStorage.setItem("beads-theme", "custom1")
    const rpcMock = installThemesRpcMock()
    // No appearance field: fails validateTheme, so loadTheme collapses to
    // FALLBACK_THEME on the very first (initial, non-epoch-triggered) apply.
    rpcMock.setTheme("custom1", { id: "custom1", name: "Custom 1", colors: {} })

    const { getByTestId } = render(withQuery(<Probe />))

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true)
    })
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      darkJson.colors.background,
    )
    // The stored preference id itself is untouched by the fallback — only
    // the applied DOM tokens fall back.
    expect(getByTestId("out").textContent).toBe("custom1:true")
  })

  // Fix 3 (listener leak): if this effect's cleanup runs before the
  // listenStderrImpl promise resolves — React 18 StrictMode double-invokes
  // effects in dev, and main.tsx wraps the app in <StrictMode> — the real
  // Tauri listener must still be unlistened once attach finally resolves,
  // mirroring lib/subscribe.ts:419-420/466.
  test("unlistens the real listener even when cleanup beats the attach promise", async () => {
    localStorage.setItem("beads-theme", "beadbox-dark")
    installThemesRpcMock()
    const unlistenMock = mock(() => undefined)
    let resolveAttach: ((fn: () => void) => void) | null = null
    const attach = mock(
      (_name: string, _cb: (data: string) => void) =>
        new Promise<() => void>((resolve) => {
          resolveAttach = resolve
        }),
    )
    _setListenStderrForTheme(attach as unknown as Parameters<typeof _setListenStderrForTheme>[0])
    _setRuntimeCheckForTheme(() => true)

    const { getByTestId, unmount } = render(withQuery(<Probe />))
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
    })
    await waitFor(() => {
      expect(attach).toHaveBeenCalled()
    })

    // Cleanup runs before the attach promise has resolved.
    unmount()

    act(() => {
      resolveAttach?.(unlistenMock)
    })

    await waitFor(() => {
      expect(unlistenMock).toHaveBeenCalledTimes(1)
    })
  })
})

// ─── Fix 5: the "reason becomes visible" chain, end to end ────────────────
//
// settings-theme-picker.test.tsx proves a ThemeEntry.error renders; the
// tests above prove the active theme stays on screen when its file goes
// bad. Neither proves the two happen TOGETHER for the theme the user is
// actually looking at — that composition requires useTheme's watcher (which
// invalidates+bumps) and SettingsDialog's picker (which reads the same
// themesQueryKey) mounted in the SAME tree, sharing the SAME QueryClient.
// SettingsDialog self-wraps with the app's singleton `queryClient`
// (lib/query-client.ts), so this test wraps both it and the hook's Probe in
// that singleton rather than withQuery's fresh-client-per-render helper.
describe("useTheme + settings dialog (task 13 fix 5)", () => {
  test("an active theme going bad surfaces its reason in the picker while staying on screen", async () => {
    localStorage.setItem("beads-theme", "custom1")
    let entries: ThemeEntry[] = [
      { id: "custom1", name: "Custom 1", appearance: "light", source: "user" },
    ]
    const v1 = { ...lightJson, id: "custom1", name: "Custom 1" }
    const themesById = new Map<string, unknown>([["custom1", v1]])
    const list = mock(async () => entries)
    const get = mock(async (id: string) => themesById.get(id) ?? null)
    const startWatch = mock(async () => undefined)
    const stopWatch = mock(async () => undefined)
    _setRpc({
      themes: { list, get, startWatch, stopWatch },
      system: { getLogDirectory: mock(async () => null) },
      bdSettings: { getBdPath: mock(async () => ({ savedPath: null })) },
    } as never)

    let cb: ((data: string) => void) | null = null
    const attach = mock(async (_name: string, fn: (data: string) => void) => {
      cb = fn
      return (() => undefined) as unknown as () => void
    })
    _setListenStderrForTheme(attach as unknown as Parameters<typeof _setListenStderrForTheme>[0])
    _setRuntimeCheckForTheme(() => true)

    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
        <SettingsDialog
          open
          onOpenChange={() => {}}
          theme="custom1"
          onThemeChange={() => {}}
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
        />
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
        v1.colors.background,
      )
    })

    // File edited to something invalid: the list now reports an error for
    // the active theme's own entry.
    entries = [
      {
        id: "custom1",
        name: "Custom 1",
        appearance: "light",
        source: "user",
        error: "colors.ring is missing",
      },
    ]

    act(() => {
      if (!cb) throw new Error("theme-change listener not yet attached")
      cb(`[THEMES:changed] ${JSON.stringify({ at: Date.now() })}\n`)
    })

    // The rejection reason reaches the picker.
    await waitFor(() => {
      expect(screen.getByText(/colors\.ring is missing/)).toBeDefined()
    })

    // Give a (wrongly) triggered re-apply a chance to land before asserting
    // its absence — an absence assertion, which cannot be polled for, same
    // as the sibling "keeps last-good on screen" test above.
    await new Promise((r) => setTimeout(r, 50))

    // The theme on screen is unchanged: the invalidation found the active
    // theme's own entry errored, so stillValid is false, the epoch never
    // bumps, and loadTheme/applyTheme never re-run for this save at all.
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      v1.colors.background,
    )
  })
})
