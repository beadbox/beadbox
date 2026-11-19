// beadbox-79a: the in-app view probe the packaged smoke drives. Inert unless
// the sidecar reports the smoke launched the app; otherwise it opens each
// target route, checks the DOM and computed styles, and reports per target.
import { afterEach, expect, mock, test } from "bun:test"
import { checkAssertions, runSmokeProbe } from "../lib/smoke-probe"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"

type Report = { target: string; ok: boolean; detail: string }

afterEach(() => {
  document.body.innerHTML = ""
  _resetRpc()
})

const target = (overrides: Record<string, unknown> = {}) => ({
  id: "all-projects",
  route: "/all-projects",
  waitFor: "[data-project-id]",
  assertions: [{ selector: '[data-project-id="a"]', minCount: 1 }],
  ...overrides,
})

function mockSmoke(responses: unknown[]) {
  const reports: Report[] = []
  const getTargets = mock(() => Promise.resolve(responses.length > 1 ? responses.shift() : responses[0]))
  _setRpc({
    smoke: {
      getTargets,
      report: (r: Report) => {
        reports.push(r)
        return Promise.resolve(true)
      },
    },
  } as unknown as RemoteApi)
  return { reports, getTargets }
}

const fast = { pollMs: 5, viewTimeoutMs: 200, targetsTimeoutMs: 500 }

test("not launched by the smoke: one RPC, no navigation, no report", async () => {
  const { reports, getTargets } = mockSmoke([{ enabled: false }])
  const navigate = mock(() => {})
  await runSmokeProbe({ navigate, ...fast })
  expect(getTargets).toHaveBeenCalledTimes(1)
  expect(navigate).not.toHaveBeenCalled()
  expect(reports).toEqual([])
})

test("waits for the smoke to publish targets, then opens each route and reports a pass", async () => {
  const { reports } = mockSmoke([
    { enabled: true, targets: null },
    { enabled: true, targets: null },
    { enabled: true, targets: [target()] },
  ])
  const routes: string[] = []
  await runSmokeProbe({
    navigate: (route) => {
      routes.push(route)
      document.body.innerHTML = '<div data-project-id="a"></div>'
    },
    ...fast,
  })
  expect(routes).toEqual(["/all-projects"])
  expect(reports).toEqual([{ target: "all-projects", ok: true, detail: "/all-projects: 1 assertion(s) hold" }])
})

test("a view that never renders reports a failure naming what was missing", async () => {
  const { reports } = mockSmoke([{ enabled: true, targets: [target()] }])
  await runSmokeProbe({ navigate: () => {}, ...fast })
  expect(reports).toEqual([
    { target: "all-projects", ok: false, detail: "/all-projects: view did not render [data-project-id]" },
  ])
})

test("too few rows fails with the count", async () => {
  const { reports } = mockSmoke([
    { enabled: true, targets: [target({ assertions: [{ selector: "[data-bead-id]", minCount: 2 }] })] },
  ])
  await runSmokeProbe({
    navigate: () => {
      document.body.innerHTML = '<div data-project-id="a" data-bead-id="x"></div>'
    },
    ...fast,
  })
  expect(reports[0]).toEqual({
    target: "all-projects",
    ok: false,
    detail: "/all-projects: [data-bead-id]: found 1, want at least 2",
  })
})

test("a computed style is compared exactly; a wrong value reports actual and wanted", () => {
  document.body.innerHTML = '<span data-status="open" style="background-color: rgb(1, 2, 3)"></span>'
  const style = (equals: string) =>
    target({ assertions: [{ selector: "[data-status=open]", style: { property: "background-color", equals } }] })
  expect(checkAssertions(style("rgb(1, 2, 3)"))).toBeNull()
  expect(checkAssertions(style("rgb(9, 9, 9)"))).toBe("[data-status=open] background-color rgb(1, 2, 3), want rgb(9, 9, 9)")
})

test("an invalid selector is a failure, not a crash", () => {
  expect(checkAssertions(target({ assertions: [{ selector: "[[", minCount: 1 }] }))).toBe("invalid selector [[")
})

test("an older sidecar without the namespace leaves the app alone", async () => {
  _setRpc({ smoke: { getTargets: () => Promise.reject(new Error("no such method")) } } as unknown as RemoteApi)
  const navigate = mock(() => {})
  await runSmokeProbe({ navigate, ...fast })
  expect(navigate).not.toHaveBeenCalled()
})
