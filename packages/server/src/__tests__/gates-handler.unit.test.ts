// handlers/gates.ts against a real bd workspace: gates made with
// `bd gate create`, read back through listWaiting and hasOpenGate, and
// resolved through resolveHumanGate (`bd gate resolve`).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import * as gates from "../handlers/gates"
import { BD_WORKSPACE_TIMEOUT_MS, createBdWorkspace, runBdInWorkspace, type Workspace } from "./fixtures/bd-workspace"

// The beforeAll below runs bd init plus eight gate creates, which can take
// well over 30 s on a busy machine. Hooks use this default (bun-types 1.1.37's
// beforeAll takes no timeout argument), so it is set explicitly here.
setDefaultTimeout(BD_WORKSPACE_TIMEOUT_MS)

let ws: Workspace
let humanGate: string
let epicGate: string
let timerGate: string
let ghRunGate: string
let ghPrGate: string
let hostileReasonGate: string
let staleGate: string
let racedGate: string

async function createGate(args: string[]): Promise<string> {
  const out = await runBdInWorkspace(["gate", "create", ...args, "--json"], ws.root)
  return (JSON.parse(out) as { id: string }).id
}

async function show(id: string): Promise<{ status: string; close_reason?: string }> {
  const out = await runBdInWorkspace(["show", id, "--json"], ws.root)
  return (JSON.parse(out) as Array<{ status: string; close_reason?: string }>)[0]!
}

async function showStatus(id: string): Promise<string> {
  return (await show(id)).status
}

beforeAll(async () => {
  ws = await createBdWorkspace()
  humanGate = await createGate([
    "--type=human",
    `--blocks=${ws.seedIds.test2}`,
    "--reason=Need design review",
  ])
  // test1 is a child of epic1 in the fixture, so it waits through the epic.
  epicGate = await createGate(["--type=human", `--blocks=${ws.seedIds.epic1}`])
  timerGate = await createGate(["--type=timer", `--blocks=${ws.seedIds.test3}`, "--timeout=2h"])
  ghRunGate = await createGate([
    "--type=gh:run",
    `--blocks=${ws.seedIds.test3}`,
    "--await-id=123456789",
  ])
  ghPrGate = await createGate(["--type=gh:pr", `--blocks=${ws.seedIds.test3}`, "--await-id=42"])
  hostileReasonGate = await createGate(["--type=human", `--blocks=${ws.seedIds.test3}`])
  staleGate = await createGate(["--type=human", `--blocks=${ws.seedIds.test3}`])
  racedGate = await createGate(["--type=human", `--blocks=${ws.seedIds.test3}`])
})

afterAll(async () => {
  await ws?.cleanup()
})

describe("handlers/gates.listWaiting", () => {
  test("lists open gates with what they hold", async () => {
    const r = await gates.listWaiting(ws.dbPath)
    if (!r.success) throw new Error(r.error)
    // bd stamps created_at to the second, so these may tie; order is by age.
    const all = [humanGate, epicGate, timerGate, ghRunGate, ghPrGate]
    all.push(hostileReasonGate, staleGate, racedGate)
    expect(r.data.map((gate) => gate.id).sort()).toEqual(all.sort())
    const ages = r.data.map((gate) => Date.parse(gate.createdAt))
    expect(ages).toEqual([...ages].sort((a, b) => a - b))

    const human = r.data.find((gate) => gate.id === humanGate)
    expect(human?.awaitType).toBe("human")
    expect(human?.description).toContain("Need design review")
    expect(human?.held.map((issue) => issue.id)).toEqual([ws.seedIds.test2])

    const epic = r.data.find((gate) => gate.id === epicGate)
    expect(epic?.held).toContainEqual(
      expect.objectContaining({ id: ws.seedIds.epic1, issueType: "epic" }),
    )
    expect(epic?.held).toContainEqual(
      expect.objectContaining({ id: ws.seedIds.test1, via: ws.seedIds.epic1 }),
    )

    const timer = r.data.find((gate) => gate.id === timerGate)
    expect(timer?.awaitType).toBe("timer")
    expect(timer?.timeoutMs).toBe(2 * 60 * 60 * 1000)
    expect(timer?.deadline).toBeString()
  })

  test("shows the awaited id of gh gates exactly as bd gave it", async () => {
    const r = await gates.listWaiting(ws.dbPath)
    if (!r.success) throw new Error(r.error)
    expect(r.data.find((gate) => gate.id === ghRunGate)).toMatchObject({
      awaitType: "gh:run",
      awaitId: "123456789",
    })
    expect(r.data.find((gate) => gate.id === ghPrGate)).toMatchObject({
      awaitType: "gh:pr",
      awaitId: "42",
    })
  })
})

describe("handlers/gates.resolveHumanGate", () => {
  test("refuses a timer gate and leaves it open", async () => {
    const r = await gates.resolveHumanGate(timerGate, ws.dbPath)
    expect(r.success).toBe(false)
    expect(r.error).toContain("not a human gate")
    expect(await showStatus(timerGate)).toBe("open")
  })

  test("refuses gh:run and gh:pr gates and leaves them open", async () => {
    for (const id of [ghRunGate, ghPrGate]) {
      const r = await gates.resolveHumanGate(id, ws.dbPath)
      expect(r.success).toBe(false)
      expect(r.error).toContain("not a human gate")
      expect(await showStatus(id)).toBe("open")
    }
  })

  test("refuses a gate named by anything but its exact ID", async () => {
    // `bd show` resolves a unique ID suffix to the full ID (bd 1.3.1's
    // `bd gate resolve` does not), so the checks must be about exactly the
    // issue the client named. Refused by the handler, before bd gate resolve.
    const suffix = humanGate.slice(humanGate.indexOf("-") + 1)
    const r = await gates.resolveHumanGate(suffix, ws.dbPath)
    expect(r).toEqual({ success: false, error: `${suffix} not found` })
    expect(await showStatus(humanGate)).toBe("open")
  })

  test("refuses a multi-line or spaced id before running bd", async () => {
    for (const id of [`${humanGate}\n--db=/tmp/evil`, `${humanGate} --db /tmp/evil`]) {
      const r = await gates.resolveHumanGate(id, ws.dbPath)
      expect(r.success).toBe(false)
      expect(r.error).toContain("Invalid bead ID")
    }
    expect(await showStatus(humanGate)).toBe("open")
  })

  test("a flag-shaped, multi-line reason with '=' is stored as data", async () => {
    const reason = "--db=/tmp/evil\nsecond line a=b"
    const r = await gates.resolveHumanGate(hostileReasonGate, ws.dbPath, reason)
    expect(r).toEqual({ success: true })
    expect(await show(hostileReasonGate)).toMatchObject({ status: "closed", close_reason: reason })
  })

  test("refuses a gate closed elsewhere after the view loaded, keeping that reason", async () => {
    await runBdInWorkspace(["gate", "resolve", staleGate, "--reason=closed in a terminal"], ws.root)
    const r = await gates.resolveHumanGate(staleGate, ws.dbPath, "from the stale view")
    expect(r.success).toBe(false)
    expect(r.error).toContain("already resolved")
    expect((await show(staleGate)).close_reason).toBe("closed in a terminal")
  })

  test("two resolves of one gate at once: one wins, the other cannot re-close it", async () => {
    const [a, b] = await Promise.all([
      gates.resolveHumanGate(racedGate, ws.dbPath, "first"),
      gates.resolveHumanGate(racedGate, ws.dbPath, "second"),
    ])
    expect([a.success, b.success].sort()).toEqual([false, true])
    expect((await show(racedGate)).close_reason).toBe(a.success ? "first" : "second")
  })

  test("refuses an issue that is not a gate", async () => {
    const r = await gates.resolveHumanGate(ws.seedIds.test2, ws.dbPath)
    expect(r.success).toBe(false)
    expect(r.error).toContain("not a gate")
    expect(await showStatus(ws.seedIds.test2)).toBe("open")
  })

  test("refuses a flag-shaped id before running bd", async () => {
    const r = await gates.resolveHumanGate("--db=/tmp/evil", ws.dbPath)
    expect(r.success).toBe(false)
  })

  test("resolves a human gate; it leaves the Waiting list and releases its task", async () => {
    const r = await gates.resolveHumanGate(humanGate, ws.dbPath, "  Design approved  ")
    expect(r).toEqual({ success: true })
    expect(await show(humanGate)).toMatchObject({
      status: "closed",
      close_reason: "Design approved",
    })

    const after = await gates.listWaiting(ws.dbPath)
    if (!after.success) throw new Error(after.error)
    expect(after.data.some((gate) => gate.id === humanGate)).toBe(false)

    const ready = JSON.parse(await runBdInWorkspace(["ready", "--json"], ws.root)) as Array<{
      id: string
    }>
    expect(ready.map((issue) => issue.id)).toContain(ws.seedIds.test2)
  })

  test("refuses a gate that is already resolved", async () => {
    const r = await gates.resolveHumanGate(humanGate, ws.dbPath)
    expect(r.success).toBe(false)
    expect(r.error).toContain("already resolved")
  })
})

// Runs last: it closes every gate still open.
describe("handlers/gates.hasOpenGate", () => {
  test("agrees with listWaiting while a gate is open, and once the last one closes", async () => {
    expect(await gates.hasOpenGate(ws.dbPath)).toEqual({ success: true, data: true })
    const before = await gates.listWaiting(ws.dbPath)
    if (!before.success) throw new Error(before.error)
    expect(before.data.length).toBeGreaterThan(0)

    // bd's own command closes any gate type; the handler would refuse these.
    for (const gate of before.data) {
      await runBdInWorkspace(["gate", "resolve", gate.id, "--reason=test teardown"], ws.root)
    }
    expect(await gates.hasOpenGate(ws.dbPath)).toEqual({ success: true, data: false })
    expect(await gates.listWaiting(ws.dbPath)).toEqual({ success: true, data: [] })
  })
})
