import { afterEach, describe, expect, mock, test } from "bun:test"
import { COLOR_KEYS } from "@beadbox/server/theme-tokens"
import { _resetRpc, _setRpc } from "../lib/rpc"
import {
  BUILTIN_THEMES,
  builtinThemeFor,
  listThemes,
  listThemesWithStatus,
  loadTheme,
} from "../lib/theme-source"

afterEach(() => {
  _resetRpc()
})

const stubRpc = (impl: Record<string, unknown>) =>
  _setRpc({ themes: impl } as unknown as Parameters<typeof _setRpc>[0])

describe("BUILTIN_THEMES", () => {
  test("ships dark and light", () => {
    expect(BUILTIN_THEMES.map((t) => t.id).sort()).toEqual(["beadbox-dark", "beadbox-light"])
  })
})

describe("builtinThemeFor", () => {
  test("dark resolves to the dark built-in", () => {
    expect(builtinThemeFor("dark").id).toBe("beadbox-dark")
  })

  test("light resolves to the light built-in", () => {
    expect(builtinThemeFor("light").id).toBe("beadbox-light")
  })
})

describe("listThemes", () => {
  test("built-ins come first, then user themes", async () => {
    stubRpc({
      list: mock(async () => [{ id: "nord", name: "Nord", appearance: "dark", source: "user" }]),
    })
    const list = await listThemes()
    expect(list.slice(0, 2).map((e) => e.id)).toEqual(["beadbox-dark", "beadbox-light"])
    expect(list.map((e) => e.id)).toContain("nord")
  })

  test("returns built-ins only when the sidecar is unavailable", async () => {
    stubRpc({
      list: mock(async () => {
        throw new Error("RpcUnavailable")
      }),
    })
    const list = await listThemes()
    expect(list.map((e) => e.id)).toEqual(["beadbox-dark", "beadbox-light"])
  })

  test("degrades to built-ins via the real RpcUnavailableError, not a mock", async () => {
    // No stubRpc here: exercises the actual buildStubRpc() path (bun test has
    // no sidecar transport), proving the catch in listThemes handles the real
    // error the production stub throws, not just a hand-rolled Error.
    const list = await listThemes()
    expect(list.map((e) => e.id)).toEqual(["beadbox-dark", "beadbox-light"])
  })

  test("a user theme cannot shadow a built-in id", async () => {
    stubRpc({
      list: mock(async () => [
        { id: "beadbox-dark", name: "Hijack", appearance: "light", source: "user" },
      ]),
    })
    const list = await listThemes()
    expect(list.filter((e) => e.id === "beadbox-dark")).toHaveLength(1)
    expect(list.find((e) => e.id === "beadbox-dark")?.name).toBe("Beadbox Dark")
  })
})

// Final whole-plan review, Fix 3: use-theme.ts's legacy migration needs to
// tell "the list succeeded and genuinely lacks this id" apart from "the
// user-theme read degraded" — a distinction listThemes() itself collapses
// (it always resolves, never rejects). listThemesWithStatus exposes it.
describe("listThemesWithStatus", () => {
  test("degraded is false and entries match listThemes on a normal read", async () => {
    stubRpc({
      list: mock(async () => [{ id: "nord", name: "Nord", appearance: "dark", source: "user" }]),
    })
    const { entries, degraded } = await listThemesWithStatus()
    expect(degraded).toBe(false)
    expect(entries.map((e) => e.id)).toEqual(["beadbox-dark", "beadbox-light", "nord"])
  })

  test("degraded is true when the sidecar read throws, even though built-ins still come back", async () => {
    stubRpc({
      list: mock(async () => {
        throw new Error("RpcUnavailable")
      }),
    })
    const { entries, degraded } = await listThemesWithStatus()
    expect(degraded).toBe(true)
    expect(entries.map((e) => e.id)).toEqual(["beadbox-dark", "beadbox-light"])
  })
})

describe("loadTheme", () => {
  test("returns a built-in without calling the sidecar", async () => {
    const get = mock(async () => null)
    stubRpc({ list: mock(async () => []), get })
    const t = await loadTheme("beadbox-light", "light")
    expect(t.appearance).toBe("light")
    expect(get).not.toHaveBeenCalled()
  })

  test("falls back to the built-in dark theme when a dark-slot theme is missing", async () => {
    stubRpc({ get: mock(async () => null) })
    const t = await loadTheme("absent", "dark")
    expect(t.id).toBe("beadbox-dark")
  })

  test("falls back to the built-in LIGHT theme when a light-slot theme is missing", async () => {
    // loadTheme's failure path must not
    // always collapse to dark — a light slot naming a missing theme must
    // get the light built-in, not dark tokens under a removed .dark class.
    stubRpc({ get: mock(async () => null) })
    const t = await loadTheme("absent", "light")
    expect(t.id).toBe("beadbox-light")
  })

  test("falls back to the built-in for the requested appearance when the sidecar returns an invalid theme", async () => {
    stubRpc({ get: mock(async () => ({ id: "bad", name: "Bad", appearance: "dark", colors: {} })) })
    expect((await loadTheme("bad", "dark")).id).toBe("beadbox-dark")
    expect((await loadTheme("bad", "light")).id).toBe("beadbox-light")
  })

  test("degrades to the requested appearance's built-in via the real RpcUnavailableError, not a mock", async () => {
    // No stubRpc here: same as above, for loadTheme's real stub path.
    expect((await loadTheme("nord", "dark")).id).toBe("beadbox-dark")
    expect((await loadTheme("nord", "light")).id).toBe("beadbox-light")
  })

  test("falls back to the requested appearance's built-in when the sidecar is unavailable", async () => {
    stubRpc({
      get: mock(async () => {
        throw new Error("RpcUnavailable")
      }),
    })
    const t = await loadTheme("nord", "light")
    expect(t.id).toBe("beadbox-light")
  })

  test("returns a validated user theme from the sidecar", async () => {
    const userTheme = {
      id: "nord",
      name: "Nord",
      appearance: "dark",
      colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, "#112233"])),
    }
    stubRpc({ get: mock(async () => userTheme) })
    const t = await loadTheme("nord", "dark")
    expect(t.id).toBe("nord")
  })
})
