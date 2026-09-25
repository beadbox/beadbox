import { describe, expect, test } from "bun:test"
import { serveReadEligibility } from "../lib/serve-eligibility"

const optedIn = { serveReads: true, mode: "server" as const, local: { path: "/ws/.beads" } }
const mac = { platform: "darwin" as const, bdVersion: "bd version 1.3.0 (f45b249ce)" }

describe("serveReadEligibility", () => {
  test("an opted-in server workspace with a scaffold on bd 1.3.0 is eligible", () => {
    expect(serveReadEligibility(optedIn, mac)).toEqual({ eligible: true })
  })

  test("only a literal true opts in (the registry is not type-validated)", () => {
    for (const serveReads of [undefined, false, "true", 1, {}, []] as unknown[]) {
      const entry = { ...optedIn, serveReads } as unknown as typeof optedIn
      expect(serveReadEligibility(entry, mac)).toEqual({ eligible: false, reason: "not-opted-in" })
    }
  })

  test("embedded, scaffold-less and Windows workspaces read through the CLI", () => {
    expect(serveReadEligibility({ ...optedIn, mode: "embedded" }, mac).eligible).toBe(false)
    expect(serveReadEligibility({ ...optedIn, mode: "embedded" }, mac)).toMatchObject({ reason: "embedded" })
    expect(serveReadEligibility({ ...optedIn, local: null }, mac)).toMatchObject({ reason: "no-local-scaffold" })
    expect(serveReadEligibility(optedIn, { ...mac, platform: "win32" })).toMatchObject({ reason: "windows" })
  })

  test("the 1.3.0 boundary follows semver, prereleases included", () => {
    const at = (bdVersion: string) => serveReadEligibility(optedIn, { ...mac, bdVersion })
    expect(at("1.3.0").eligible).toBe(true)
    expect(at("v1.3.1").eligible).toBe(true)
    expect(at("1.3.1-rc.1").eligible).toBe(true)
    expect(at("2.0.0").eligible).toBe(true)
    expect(at("1.3.0-rc.2")).toMatchObject({ reason: "bd-too-old" })
    expect(at("bd version 1.2.2 (Homebrew)")).toMatchObject({ reason: "bd-too-old" })
    expect(at("1.1.0")).toMatchObject({ reason: "bd-too-old" })
  })

  test("an unreadable version is unknown, not old", () => {
    for (const bdVersion of [null, "", "garbage", "1.3", "bd version dev"]) {
      expect(serveReadEligibility(optedIn, { ...mac, bdVersion })).toMatchObject({
        eligible: false,
        reason: "bd-version-unknown",
      })
    }
  })

  test("an integrity failure disables an otherwise eligible workspace", () => {
    expect(serveReadEligibility(optedIn, { ...mac, disabledReason: "identity mismatch" })).toEqual({
      eligible: false,
      reason: "disabled",
      detail: "identity mismatch",
    })
  })

  test("reasons are reported in order: the first blocker wins", () => {
    const worst = { serveReads: false, mode: "embedded" as const, local: null }
    expect(serveReadEligibility(worst, { platform: "win32", bdVersion: null })).toMatchObject({
      reason: "not-opted-in",
    })
    expect(
      serveReadEligibility({ ...worst, serveReads: true }, { platform: "win32", bdVersion: null }),
    ).toMatchObject({ reason: "embedded" })
  })
})
