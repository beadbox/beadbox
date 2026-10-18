// The release guard (beadbox-r72.2): a build with the test transport off fails
// if any output carries it, by content or chunk name, sourcemaps included.

import { describe, expect, test } from "bun:test"
import {
  findTestTransport,
  TEST_TRANSPORT_MARKER,
  testTransportEnabled,
  testTransportGuard,
} from "../../vite-plugins/test-transport-guard"

type Bundle = Parameters<typeof findTestTransport>[0]

function runGuard(enabled: boolean, bundle: Bundle): string | null {
  const plugin = testTransportGuard(enabled)
  const context = {
    error: (message: string) => {
      throw new Error(message)
    },
  }
  try {
    ;(
      plugin.generateBundle as unknown as (this: typeof context, o: unknown, b: Bundle) => void
    ).call(context, {}, bundle)
    return null
  } catch (error) {
    return (error as Error).message
  }
}

const clean: Bundle = {
  "assets/index-abc.js": { type: "chunk", code: "console.log('app')" },
  "assets/index-abc.js.map": { type: "asset", source: '{"sourcesContent":["app"]}' },
}

describe("findTestTransport", () => {
  test("finds the marker in a chunk, a string sourcemap and a binary asset", () => {
    expect(
      findTestTransport({
        ...clean,
        "assets/a.js": { type: "chunk", code: `x.${TEST_TRANSPORT_MARKER}` },
        "assets/a.js.map": {
          type: "asset",
          source: `{"sourcesContent":["${TEST_TRANSPORT_MARKER}"]}`,
        },
        "assets/b.bin": { type: "asset", source: new TextEncoder().encode(TEST_TRANSPORT_MARKER) },
      }),
    ).toEqual(["assets/a.js", "assets/a.js.map", "assets/b.bin"])
  })

  test("finds a test-transport chunk by name even without the marker", () => {
    expect(
      findTestTransport({ ...clean, "assets/test-transport-x1.js": { type: "chunk", code: "" } }),
    ).toEqual(["assets/test-transport-x1.js"])
  })

  test("finds nothing in a clean bundle", () => {
    expect(findTestTransport(clean)).toEqual([])
  })
})

describe("testTransportGuard", () => {
  test("flag off: a carried marker fails the build, naming the file", () => {
    const message = runGuard(false, {
      ...clean,
      "assets/x.js": { type: "chunk", code: TEST_TRANSPORT_MARKER },
    })
    expect(message).toContain("[test-transport-guard]")
    expect(message).toContain("assets/x.js")
  })

  test("flag off: a clean bundle builds", () => {
    expect(runGuard(false, clean)).toBeNull()
  })

  test("flag on: the test build is allowed to carry it", () => {
    expect(
      runGuard(true, {
        "assets/test-transport-x1.js": { type: "chunk", code: TEST_TRANSPORT_MARKER },
      }),
    ).toBeNull()
  })

  test("runs on builds only", () => {
    expect(testTransportGuard(false).apply).toBe("build")
  })
})

describe("testTransportEnabled", () => {
  test('only BEADBOX_TEST_TRANSPORT === "1" turns it on', () => {
    expect(testTransportEnabled({ BEADBOX_TEST_TRANSPORT: "1" })).toBe(true)
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      expect(testTransportEnabled({ BEADBOX_TEST_TRANSPORT: value })).toBe(false)
    }
  })

  test("bun test never sees it on", () => {
    expect(testTransportEnabled()).toBe(false)
  })
})
