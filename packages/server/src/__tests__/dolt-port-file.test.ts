// The shared dolt-server.port validator (beadbox-01f.5, from beadbox-0h2).

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsePort, parsePortValue, readPortFile, readPortFileSync } from "../lib/dolt-port-file"

describe("parsePort", () => {
  const cases: Array<[string, number | null]> = [
    ["", null],
    ["abc", null],
    ["45522abc", null], // parseInt used to read this as 45522
    ["0", null],
    ["70000", null], // several readers had no upper bound
    ["65536", null],
    ["-1", null],
    ["+80", null],
    ["1e3", null],
    ["45522.0", null],
    ["  45522\n", 45522],
    ["1", 1],
    ["65535", 65535],
  ]
  for (const [raw, expected] of cases) {
    test(`${JSON.stringify(raw)} → ${expected}`, () => {
      expect(parsePort(raw)).toBe(expected)
    })
  }
})

test("parsePortValue accepts only integers in range", () => {
  expect(parsePortValue(14599)).toBe(14599)
  expect(parsePortValue(0)).toBeNull()
  expect(parsePortValue(65536)).toBeNull()
  expect(parsePortValue(3307.5)).toBeNull()
  expect(parsePortValue("3307")).toBeNull()
  expect(parsePortValue(undefined)).toBeNull()
})

describe("readPortFile / readPortFileSync report the four outcomes", () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })
  async function dir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "beadbox-portfile-"))
    roots.push(root)
    const beads = join(root, ".beads")
    await mkdir(beads)
    return beads
  }

  test("ok, missing, invalid", async () => {
    const ok = await dir()
    await writeFile(join(ok, "dolt-server.port"), "51000\n")
    expect(readPortFileSync(ok)).toEqual({ status: "ok", port: 51000 })
    expect(await readPortFile(ok)).toEqual({ status: "ok", port: 51000 })

    const missing = await dir()
    expect(readPortFileSync(missing)).toEqual({ status: "missing" })
    expect(await readPortFile(missing)).toEqual({ status: "missing" })

    const invalid = await dir()
    await writeFile(join(invalid, "dolt-server.port"), "45522abc")
    expect(readPortFileSync(invalid)).toEqual({ status: "invalid", raw: "45522abc" })
  })

  test("unreadable is not mistaken for missing", async () => {
    const beads = await dir()
    await mkdir(join(beads, "dolt-server.port")) // a directory: EISDIR
    expect(readPortFileSync(beads).status).toBe("unreadable")
    expect((await readPortFile(beads)).status).toBe("unreadable")
    await chmod(beads, 0o755)
  })
})
