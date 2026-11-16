import { afterEach, describe, expect, mock, test } from "bun:test"
import { COLOR_KEYS } from "@beadbox/server/theme-tokens"
import { _resetRpc, _setRpc } from "../lib/rpc"
import { BUILTIN_THEMES, FALLBACK_THEME, listThemes, loadTheme } from "../lib/theme-source"

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

describe("FALLBACK_THEME", () => {
  test("is the dark built-in", () => {
    expect(FALLBACK_THEME.id).toBe("beadbox-dark")
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

describe("loadTheme", () => {
  test("returns a built-in without calling the sidecar", async () => {
    const get = mock(async () => null)
    stubRpc({ list: mock(async () => []), get })
    const t = await loadTheme("beadbox-light")
    expect(t.appearance).toBe("light")
    expect(get).not.toHaveBeenCalled()
  })

  test("falls back to the built-in dark theme when a theme is missing", async () => {
    stubRpc({ get: mock(async () => null) })
    const t = await loadTheme("absent")
    expect(t.id).toBe("beadbox-dark")
  })

  test("falls back when the sidecar returns an invalid theme", async () => {
    stubRpc({ get: mock(async () => ({ id: "bad", name: "Bad", appearance: "dark", colors: {} })) })
    const t = await loadTheme("bad")
    expect(t.id).toBe("beadbox-dark")
  })

  test("degrades to the fallback via the real RpcUnavailableError, not a mock", async () => {
    // No stubRpc here: same as above, for loadTheme's real stub path.
    const t = await loadTheme("nord")
    expect(t.id).toBe("beadbox-dark")
  })

  test("falls back when the sidecar is unavailable", async () => {
    stubRpc({
      get: mock(async () => {
        throw new Error("RpcUnavailable")
      }),
    })
    const t = await loadTheme("nord")
    expect(t.id).toBe("beadbox-dark")
  })

  test("returns a validated user theme from the sidecar", async () => {
    const userTheme = {
      id: "nord",
      name: "Nord",
      appearance: "dark",
      colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, "#112233"])),
    }
    stubRpc({ get: mock(async () => userTheme) })
    const t = await loadTheme("nord")
    expect(t.id).toBe("nord")
  })
})
