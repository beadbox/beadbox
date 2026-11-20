// Wiring the stored theme preference into app startup.
// The single stored theme
// id became a MODE (dark/light/system) plus a theme assigned to each of
// the dark and light slots. useTheme() now exposes the theme actually
// rendered (activeThemeId) and the resolved appearance, not a raw
// preference id — see use-theme-preference.ts and use-theme.ts.
//
// The theme preference is ONE observable store (local-storage.ts), not local
// state owned by this hook — so a write from any consumer must reach every
// other subscriber without a reload. (usePreferences no longer
// subscribes to theme state — the settings dialog reads/writes
// the store directly via useThemePreference() — so the "independent
// subscribers" below are this hook's own Probe and a raw useThemePreference
// subscriber.)

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type ReactNode, StrictMode } from "react"
import { SettingsDialog } from "../components/settings-dialog"
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
  DEFAULT_THEME_PREFS,
  getThemePrefs,
  setThemeForAppearance,
  setThemeMode,
  subscribeThemePreference,
} from "../lib/local-storage"
import { queryClient } from "../lib/query-client"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import { __resetProbeCache } from "../lib/theme-engine"
import type { ThemeEntry } from "../lib/theme-source"
import darkJson from "../themes/beadbox-dark.json"
import lightJson from "../themes/beadbox-light.json"

// useTheme() now reads useQueryClient() (task 13's hot-reload re-apply
// path, and task 4's legacy migration), so every render needs a
// QueryClientProvider ancestor — a fresh client per render keeps tests
// isolated from each other's cache.
function withQuery(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

function Probe() {
  const { activeThemeId, available } = useTheme()
  return <div data-testid="out">{`${activeThemeId}:${available}`}</div>
}

function renderProbe() {
  return render(withQuery(<Probe />))
}

function SetterProbe() {
  const {
    activeThemeId,
    appearance,
    setThemeForAppearance: setForAppearance,
  } = useThemePreference()
  return (
    <div>
      <div data-testid="setter-out">{activeThemeId}</div>
      <button type="button" onClick={() => setForAppearance(appearance, "beadbox-light")}>
        switch
      </button>
    </div>
  )
}

function SubscriptionProbe() {
  const { activeThemeId } = useThemePreference()
  return <div data-testid="subscription-out">{activeThemeId}</div>
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

// ─── Hot-reload test helpers ─────────────────────────────────────

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
  test("applies the dark slot's theme in dark mode", async () => {
    setThemeMode("dark")
    setThemeForAppearance("dark", "beadbox-dark")
    const { getByTestId } = renderProbe()
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
      expect(document.documentElement.classList.contains("dark")).toBe(true)
    })
  })

  test("applies the light slot's theme when mode is light", async () => {
    setThemeMode("light")
    const { getByTestId } = renderProbe()
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-light:true")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      lightJson.colors.background,
    )
  })

  test("defaults to the dark theme with no stored preference", async () => {
    const { getByTestId } = renderProbe()
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  test("switching mode to light applies the light slot's theme and drops the class", async () => {
    renderProbe()
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))

    act(() => {
      setThemeMode("light")
    })

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(false)
      expect(document.documentElement.style.getPropertyValue("--bb-background").trim()).toBe(
        lightJson.colors.background,
      )
    })
  })

  test("system mode follows the OS, and a live OS change re-resolves it", async () => {
    // Drive the media query through a settable seam so the change event can fire.
    let prefersDark = true
    const listeners = new Set<() => void>()
    const original = window.matchMedia
    window.matchMedia = (() => ({
      get matches() {
        return prefersDark
      },
      addEventListener: (_: string, l: () => void) => {
        listeners.add(l)
      },
      removeEventListener: (_: string, l: () => void) => {
        listeners.delete(l)
      },
    })) as unknown as typeof window.matchMedia
    try {
      setThemeMode("system")
      renderProbe()
      await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))

      act(() => {
        prefersDark = false
        for (const l of listeners) l()
      })

      await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false))
    } finally {
      window.matchMedia = original
    }
  })

  // The most important test in the file: the five-mirrors problem the
  // addendum describes would mean a change made outside this hook never
  // reaches the root that applies tokens to <html>. A local useState in
  // useTheme would pass every other test here while still shipping that
  // bug, because nothing else writes through this hook's own store.
  test("a write through setThemeForAppearance from outside the hook propagates", async () => {
    const { getByTestId } = renderProbe()
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
    })

    act(() => {
      setThemeForAppearance("dark", "beadbox-light")
    })

    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-light:true")
    })
    // Mode is still "dark" — only the dark slot's assigned theme changed —
    // so the appearance class is unaffected by this write.
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  test("setThemeForAppearance persists to storage and updates activeThemeId", async () => {
    const { getByTestId } = render(withQuery(<SetterProbe />))
    await waitFor(() => {
      expect(getByTestId("setter-out").textContent).toBe("beadbox-dark")
    })

    fireEvent.click(document.querySelector("button") as HTMLButtonElement)

    await waitFor(() => {
      expect(getByTestId("setter-out").textContent).toBe("beadbox-light")
    })
    expect(getThemePrefs().darkThemeId).toBe("beadbox-light")
  })

  test("two independent subscribers both observe a change made through either", async () => {
    const { getByTestId } = render(
      withQuery(
        <div>
          <Probe />
          <SubscriptionProbe />
        </div>,
      ),
    )
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
      expect(getByTestId("subscription-out").textContent).toBe("beadbox-dark")
    })

    // Change made through the OTHER subscriber's channel (direct storage
    // write, standing in for a change made by the settings dialog, which
    // also just calls setThemeForAppearance).
    act(() => {
      setThemeForAppearance("dark", "beadbox-light")
    })

    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-light:true")
      expect(getByTestId("subscription-out").textContent).toBe("beadbox-light")
    })
  })

  test("subscribeThemePreference's unsubscribe actually detaches", () => {
    let calls = 0
    const unsubscribe = subscribeThemePreference(() => {
      calls++
    })
    setThemeMode("light")
    expect(calls).toBe(1)

    unsubscribe()
    setThemeMode("dark")
    expect(calls).toBe(1)
  })

  test("writes no --bb-* property when theming is unavailable", async () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = () => {
      throw new Error("Simulated engine failure")
    }
    try {
      const { getByTestId } = renderProbe()
      await waitFor(() => {
        expect(getByTestId("out").textContent).toBe("beadbox-dark:false")
      })
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe("")
  })
})

// ─── Legacy single-id migration ────────────────────────────────────
//
// Installs predating appearance mode stored one theme id under "beads-theme". On first launch
// after the upgrade, that id must be adopted into whichever slot matches
// its own appearance, and the mode set to match — but ONLY when the new
// three-value key has never been written, so a deliberate choice already
// made under the new model is never clobbered by a stale legacy value.

describe("useTheme legacy migration", () => {
  test("migrates a legacy single-id preference into the slot matching its appearance", async () => {
    localStorage.setItem("beads-theme", "beadbox-light")
    _resetThemePreferenceForTests()

    renderProbe()

    await waitFor(() => {
      expect(getThemePrefs()).toEqual({
        mode: "light",
        darkThemeId: "beadbox-dark",
        lightThemeId: "beadbox-light",
      })
    })
    // The legacy key is removed so it cannot become a second source of truth.
    expect(localStorage.getItem("beads-theme")).toBeNull()
  })

  // Regression test for a bug caught after the first version of this task:
  // main.tsx wraps the app in <StrictMode>, which double-invokes effects in
  // dev (setup → cleanup → setup, same refs). A migration effect that set a
  // "already migrated" ref SYNCHRONOUSLY — before its async fetchQuery
  // resolved — would see: pass 1 sets the ref and starts the fetch, cleanup
  // cancels that fetch's result, pass 2 sees the ref already set and skips
  // entirely. The migration would never complete under StrictMode, only in
  // production's single effect run. render() from @testing-library/react is
  // NOT StrictMode-wrapped, so no other test in this file would ever catch
  // that. This one mounts inside <StrictMode> deliberately.
  test("migration completes under StrictMode's double-invoked effects", async () => {
    localStorage.setItem("beads-theme", "beadbox-light")
    _resetThemePreferenceForTests()

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(getThemePrefs()).toEqual({
        mode: "light",
        darkThemeId: "beadbox-dark",
        lightThemeId: "beadbox-light",
      })
    })
    expect(localStorage.getItem("beads-theme")).toBeNull()
  })

  test("a legacy id whose theme is no longer installed falls back to defaults", async () => {
    // A working (non-throwing) themes list that just doesn't contain
    // "uninstalled" — this test is about a successful read that genuinely
    // lacks the id, not a degraded sidecar read (see the next test for
    // that).
    installThemesRpcMock()
    localStorage.setItem("beads-theme", "uninstalled")
    _resetThemePreferenceForTests()

    renderProbe()

    // Real delay, then a synchronous assert — NOT waitFor. waitFor would
    // pass trivially here: DEFAULT_THEME_PREFS is already the state at
    // t=0, before the migration's listThemesWithStatus() call has even had
    // a chance to resolve, and waitFor runs its callback synchronously on
    // the first pass. A migration that wrongly adopted an uninstalled id
    // would write, then clear the key, and a waitFor-based assert here
    // would stay green throughout. See "migration does not run when prefs
    // already exist" below for the same pattern.
    await new Promise((r) => setTimeout(r, 50))
    expect(getThemePrefs()).toEqual(DEFAULT_THEME_PREFS)
    expect(localStorage.getItem("beads-theme")).toBeNull()
  })

  // A legacy id naming a real USER theme
  // (not a built-in, which is always resolvable regardless of the sidecar)
  // must survive a degraded read — the sidecar failing on this exact launch
  // is not proof the theme is uninstalled, and clearing the legacy key here
  // would discard the user's preference permanently with nothing to retry.
  test("a legacy id naming a user theme is preserved, not discarded, when the themes read degrades", async () => {
    // No installThemesRpcMock() here: the default stub throws
    // RpcUnavailableError for every call, standing in for the sidecar
    // having failed on this exact launch.
    localStorage.setItem("beads-theme", "nord")
    _resetThemePreferenceForTests()

    renderProbe()

    // Real delay, not waitFor: there is nothing to wait FOR here — the bug
    // this guards against is a silent, immediate loss of the user's
    // preference, with no observable change to wait on.
    await new Promise((r) => setTimeout(r, 50))
    expect(getThemePrefs()).toEqual(DEFAULT_THEME_PREFS)
    expect(localStorage.getItem("beads-theme")).toBe("nord")
  })

  // The guard this test protects: migration must key off "has the new
  // three-value key ever been written", not "does a legacy id happen to
  // exist". Without that guard, a legacy key left behind (e.g. from
  // clearCache not having run yet) would overwrite a deliberate, newer
  // choice with a stale one on every launch.
  test("migration does not run when prefs already exist", async () => {
    setThemeMode("light")
    localStorage.setItem("beads-theme", "beadbox-dark")

    renderProbe()

    // This is an absence assertion (migration must NOT have overwritten
    // mode), so it cannot be a waitFor that returns the instant it first
    // passes — mode reads "light" synchronously from the write above,
    // before the migration effect's fetchQuery has even had a chance to
    // resolve. Give any (wrongly) running migration a real chance to land
    // its write first.
    await new Promise((r) => setTimeout(r, 50))
    expect(getThemePrefs().mode).toBe("light")
  })
})

// ─── Hot reload on file change ────────────────────────────────────
//
// Per task-13-addendum: a [THEMES:changed] stderr line (emitted by
// themes.startWatch(), see packages/server/src/handlers/themes.ts) must
// re-apply the active theme when it still validates, and must leave the
// currently applied theme untouched — not fall back to FALLBACK_THEME —
// when it no longer validates. The reason reaches the picker purely
// through the themesQueryKey invalidation (tested in settings-dialog's own
// suite); here we test the apply/no-apply decision itself.
//
// Setup goes directly through setThemeMode/setThemeForAppearance rather
// than the legacy "beads-theme" key, so these tests exercise hot reload in
// isolation from the migration covered above.

describe("useTheme hot reload", () => {
  test("re-applies the active theme when the changed file still validates", async () => {
    setThemeMode("light")
    setThemeForAppearance("light", "custom1")
    const rpcMock = installThemesRpcMock()
    const v1 = { ...lightJson, id: "custom1", name: "Custom 1" }
    rpcMock.setTheme("custom1", v1)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "light", source: "user" }])
    const listen = installThemeChangeListener()

    const { getByTestId } = renderProbe()
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("custom1:true")
      expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
        v1.colors.background,
      )
    })

    // Simulate the file being edited: still valid, different colours, SAME
    // appearance ("light", matching the slot) — a flipped appearance on an
    // otherwise-valid edit is its own scenario, covered separately below
    // (the appearance-mismatch guard would otherwise refuse this edit too,
    // which is not what this test is about).
    const v2 = {
      ...lightJson,
      id: "custom1",
      name: "Custom 1",
      colors: { ...lightJson.colors, background: "#001122" },
    }
    rpcMock.setTheme("custom1", v2)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "light", source: "user" }])

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

  // The appearance-coherence cluster. A hot
  // reload must not paint the wrong-appearance theme's tokens under the
  // slot's own resolved appearance class — editing custom1's `appearance`
  // field from "dark" to "light" in place (same id, so the id-based guard
  // above does not fire) must not leave the dark slot painted with light
  // tokens under .dark.
  test("refuses a hot-reloaded theme whose appearance no longer matches its slot", async () => {
    setThemeMode("dark")
    setThemeForAppearance("dark", "custom1")
    const rpcMock = installThemesRpcMock()
    // v1's background is deliberately NOT the dark built-in's own value: a
    // distinct custom colour so that "the dark built-in got applied after
    // hot reload" (the correct, guarded outcome) cannot be confused with
    // "the hot reload never fired and v1 is still on screen" (ambiguous
    // with the built-in only because v1 happens to be a copy of it).
    const v1 = {
      ...darkJson,
      id: "custom1",
      name: "Custom 1",
      colors: { ...darkJson.colors, background: "#123456" },
    }
    rpcMock.setTheme("custom1", v1)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "dark", source: "user" }])
    const listen = installThemeChangeListener()

    const { getByTestId } = renderProbe()
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("custom1:true")
      expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
        v1.colors.background,
      )
    })
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    // Same id, flipped appearance: still validates (appearance is a legal
    // value, just the wrong one for the dark slot it is assigned to).
    const v2 = { ...lightJson, id: "custom1", name: "Custom 1" }
    rpcMock.setTheme("custom1", v2)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "light", source: "user" }])

    act(() => {
      listen.fire()
    })

    await waitFor(() => {
      // Refused, and replaced with the dark slot's own built-in — not the
      // mis-slotted theme's light tokens, and not a no-op that leaves v1
      // on screen either: v1's tokens no longer reflect what the slot's
      // assigned theme file actually contains once the file itself has
      // changed appearance.
      expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
        darkJson.colors.background,
      )
    })
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  test("keeps the last-good theme on screen when the changed file no longer validates", async () => {
    setThemeMode("light")
    setThemeForAppearance("light", "custom1")
    const rpcMock = installThemesRpcMock()
    const v1 = { ...lightJson, id: "custom1", name: "Custom 1" }
    rpcMock.setTheme("custom1", v1)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "light", source: "user" }])
    const listen = installThemeChangeListener()

    const { getByTestId } = renderProbe()
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
    setThemeMode("light")
    setThemeForAppearance("light", "custom1")
    const rpcMock = installThemesRpcMock()
    const v1 = { ...lightJson, id: "custom1", name: "Custom 1" }
    rpcMock.setTheme("custom1", v1)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "light", source: "user" }])
    const listen = installThemeChangeListener()

    const { getByTestId } = renderProbe()
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
    const rpcMock = installThemesRpcMock()
    // No installThemeChangeListener(): runtimeCheck defaults to
    // hasSidecarTransport(), which is false under bun test.
    const { getByTestId } = renderProbe()
    await waitFor(() => {
      expect(getByTestId("out").textContent).toBe("beadbox-dark:true")
    })
    expect(rpcMock.startWatch).not.toHaveBeenCalled()
  })

  // The new process boots with
  // packages/server/src/handlers/themes.ts's stopWatcher back at null, and
  // nothing re-arms the watch unless the client calls startWatch() again
  // against the new process. lib/rpc.ts dispatches "beadbox:sidecar-exit"
  // for exactly this; the watcher effect must re-run on it, mirroring
  // lib/subscribe.ts's transportEpoch.
  test("re-subscribes (startWatch again) after a beadbox:sidecar-exit event", async () => {
    const rpcMock = installThemesRpcMock()
    rpcMock.setEntries([])
    installThemeChangeListener()

    const { getByTestId } = renderProbe()
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

  // The watcher's list refetch can still find the active theme valid (so the
  // epoch bumps) while a SECOND, invalid save has already landed on disk by
  // the time loadTheme actually reads the file — rpc.themes.get now returns
  // something that fails validateTheme, so loadTheme collapses to
  // FALLBACK_THEME. The apply effect must refuse that result rather than
  // applying it, or the app would be stranded on Beadbox Dark until the
  // file becomes valid again.
  test("a hot-reload re-apply that resolves the fallback theme leaves the on-screen theme untouched", async () => {
    setThemeMode("light")
    setThemeForAppearance("light", "custom1")
    const rpcMock = installThemesRpcMock()
    const v1 = { ...lightJson, id: "custom1", name: "Custom 1" }
    rpcMock.setTheme("custom1", v1)
    rpcMock.setEntries([{ id: "custom1", name: "Custom 1", appearance: "light", source: "user" }])
    const listen = installThemeChangeListener()

    const { getByTestId } = renderProbe()
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
  //
  // This also exercises the slot-id/applied-DOM distinction under the new
  // model: the slot keeps holding the id it was assigned even though the
  // thing actually painted on screen falls back to the bundled theme.
  test("startup still falls back to the bundled dark theme when the active slot's theme fails validation", async () => {
    setThemeForAppearance("dark", "custom1")
    const rpcMock = installThemesRpcMock()
    // No appearance field: fails validateTheme, so loadTheme collapses to
    // FALLBACK_THEME on the very first (initial, non-epoch-triggered) apply.
    rpcMock.setTheme("custom1", { id: "custom1", name: "Custom 1", colors: {} })

    const { getByTestId } = renderProbe()

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true)
    })
    expect(document.documentElement.style.getPropertyValue("--bb-background")).toBe(
      darkJson.colors.background,
    )
    // The slot's assigned id itself is untouched by the fallback — only
    // the applied DOM tokens fall back.
    expect(getByTestId("out").textContent).toBe("custom1:true")
  })

  // If this effect's cleanup runs before the
  // listenStderrImpl promise resolves — React 18 StrictMode double-invokes
  // effects in dev, and main.tsx wraps the app in <StrictMode> — the real
  // Tauri listener must still be unlistened once attach finally resolves,
  // mirroring lib/subscribe.ts:419-420/466.
  test("unlistens the real listener even when cleanup beats the attach promise", async () => {
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

    const { getByTestId, unmount } = renderProbe()
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

// ─── The "reason becomes visible" chain, end to end ────────────────
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
    setThemeMode("light")
    setThemeForAppearance("light", "custom1")
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
