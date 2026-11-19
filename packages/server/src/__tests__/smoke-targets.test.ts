// beadbox-79a: the packaged smoke's view targets. Inert unless the smoke
// launched the app; strict about the file it reads; one log line per report.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _resetSmokeForTests, readSmokeTargets, reportSmokeView } from "../lib/smoke-targets"

const ORIGINAL = process.env.BEADBOX_SMOKE_VIEWS
let dir: string
let file: string
let errors: ReturnType<typeof spyOn>

const target = {
  id: "all-projects",
  route: "/all-projects",
  waitFor: "[data-project-id]",
  assertions: [{ selector: "[data-bead-id]", minCount: 1 }],
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "beadbox-smoke-"))
  file = join(dir, "targets.json")
  delete process.env.BEADBOX_SMOKE_VIEWS
  _resetSmokeForTests()
  errors = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  errors.mockRestore()
  await rm(dir, { recursive: true, force: true })
  if (ORIGINAL === undefined) delete process.env.BEADBOX_SMOKE_VIEWS
  else process.env.BEADBOX_SMOKE_VIEWS = ORIGINAL
})

const smokeLines = () =>
  (errors.mock.calls as unknown[][])
    .map((c: unknown[]) => String(c[0]))
    .filter((line: string) => line.startsWith("[smoke-view] "))

test("without BEADBOX_SMOKE_VIEWS the probe is disabled and reports nothing", () => {
  expect(readSmokeTargets()).toEqual({ enabled: false })
  expect(reportSmokeView({ target: "all-projects", ok: true, detail: "x" })).toBe(false)
  expect(smokeLines()).toEqual([])
})

test("a relative or NUL path counts as not set", () => {
  process.env.BEADBOX_SMOKE_VIEWS = "targets.json"
  expect(readSmokeTargets()).toEqual({ enabled: false })
  process.env.BEADBOX_SMOKE_VIEWS = `${file}\0x`
  expect(readSmokeTargets()).toEqual({ enabled: false })
})

test("enabled with no file yet: keep waiting (targets null), no log line", () => {
  process.env.BEADBOX_SMOKE_VIEWS = file
  expect(readSmokeTargets()).toEqual({ enabled: true, targets: null })
  expect(smokeLines()).toEqual([])
})

test("a valid file returns its targets, ignoring unknown keys", async () => {
  process.env.BEADBOX_SMOKE_VIEWS = file
  await writeFile(file, JSON.stringify({ _comment: "x", targets: [target] }))
  expect(readSmokeTargets()).toEqual({ enabled: true, targets: [target] })
})

test.each([
  ["not JSON", "{"],
  ["no targets", JSON.stringify({ targets: [] })],
  ["bad id", JSON.stringify({ targets: [{ ...target, id: "Bad Id" }] })],
  ["route without slash", JSON.stringify({ targets: [{ ...target, route: "all-projects" }] })],
  ["assertion with nothing to check", JSON.stringify({ targets: [{ ...target, assertions: [{ selector: "a" }] }] })],
  [
    "style property with odd characters",
    JSON.stringify({
      targets: [{ ...target, assertions: [{ selector: "a", style: { property: "color;x", equals: "red" } }] }],
    }),
  ],
])("an invalid file (%s) gives null targets and one log line", async (_name, contents) => {
  process.env.BEADBOX_SMOKE_VIEWS = file
  await writeFile(file, contents)
  expect(readSmokeTargets()).toEqual({ enabled: true, targets: null })
  readSmokeTargets()
  const lines = smokeLines()
  expect(lines.length).toBe(1)
  expect(JSON.parse(lines[0].slice("[smoke-view] ".length))).toMatchObject({ target: "_targets", ok: false })
})

test("a report is one JSON line the smoke can match; bad reports are dropped", () => {
  process.env.BEADBOX_SMOKE_VIEWS = file
  expect(reportSmokeView({ target: "status-colors-gray", ok: false, detail: "want\nred" })).toBe(true)
  expect(reportSmokeView({ target: "../x", ok: true, detail: "" })).toBe(false)
  expect(reportSmokeView({ target: "x", ok: "yes" as unknown as boolean, detail: "" })).toBe(false)
  const lines = smokeLines()
  expect(lines).toEqual(['[smoke-view] {"target":"status-colors-gray","ok":false,"detail":"want\\nred"}'])
})
