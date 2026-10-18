// beadbox-429 (GH #56): bd's status.custom entries may carry a category,
// `name:category`. A bead's status is always the bare name, so every surface
// Beadbox offers (status list, advancement chain, Settings) must use names,
// and a Settings save must keep each existing entry's suffix. Real bd CLI,
// scratch workspace (synthetic data only).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"

import * as beads from "../handlers/beads"
import { createBdWorkspace, runBdInWorkspace, type Workspace } from "./fixtures/bd-workspace"

setDefaultTimeout(30_000)

const CONFIG = "ticket_awaiting:active,ticket_active:wip,unit_escalated:frozen"
const NAMES = ["ticket_awaiting", "ticket_active", "unit_escalated"]

let ws: Workspace

const configValue = async () => (await runBdInWorkspace(["config", "get", "status.custom"], ws.root)).trim()
const setConfig = (value: string) => runBdInWorkspace(["config", "set", "status.custom", value], ws.root)

beforeAll(async () => {
  ws = await createBdWorkspace()
})

afterAll(async () => {
  await ws?.cleanup()
})

describe("name:category custom statuses", () => {
  test("getCustomStatusList returns the names, in config order", async () => {
    await setConfig(CONFIG)
    expect(await beads.getCustomStatusList(ws.dbPath)).toEqual(NAMES)
  })

  test("getAvailableStatuses offers the names (no suffix) and every bd built-in", async () => {
    await setConfig(CONFIG)
    const all = await beads.getAvailableStatuses(ws.dbPath)
    for (const s of all) expect({ s, colon: s.includes(":") }).toEqual({ s, colon: false })
    for (const name of NAMES) expect(all).toContain(name)
    // bd's built-ins beyond the core three are statuses a bead can hold.
    for (const builtIn of ["open", "in_progress", "blocked", "deferred", "closed"]) expect(all).toContain(builtIn)
    // Custom statuses follow config order (bd statuses lists them alphabetically).
    expect(all.filter((s) => NAMES.includes(s))).toEqual(NAMES)
  })

  test("advancing along the chain writes the bare name, which bd accepts", async () => {
    await setConfig(CONFIG)
    const chain = await beads.getCustomStatusList(ws.dbPath)
    const id = ws.seedIds.test2
    for (const next of chain) {
      const r = await beads.updateBeadStatus(id, next, ws.dbPath)
      expect({ next, ...r }).toEqual({ next, success: true })
      const shown = JSON.parse(await runBdInWorkspace(["show", id, "--json"], ws.root))
      expect((Array.isArray(shown) ? shown[0] : shown).status).toBe(next)
    }
  })

  test("a Settings reorder keeps every entry's category suffix", async () => {
    await setConfig(CONFIG)
    const r = await beads.updateCustomStatuses(["unit_escalated", "ticket_awaiting", "ticket_active"], ws.dbPath)
    expect(r).toEqual({ success: true })
    expect(await configValue()).toBe("unit_escalated:frozen,ticket_awaiting:active,ticket_active:wip")
  })

  test("a Settings remove + add keeps the survivors' suffixes and writes the new name bare", async () => {
    await setConfig(CONFIG)
    const r = await beads.updateCustomStatuses(["ticket_active", "in_review"], ws.dbPath)
    expect(r).toEqual({ success: true })
    expect(await configValue()).toBe("ticket_active:wip,in_review")
  })

  test("a colon in a NEW name is still rejected, without writing", async () => {
    await setConfig(CONFIG)
    const r = await beads.updateCustomStatuses([...NAMES, "triage:wip"], ws.dbPath)
    expect(r.success).toBe(false)
    expect(await configValue()).toBe(CONFIG)
  })

  test("the plain comma form keeps working unchanged", async () => {
    await setConfig("ready_for_qa,qa_passed")
    expect(await beads.getCustomStatusList(ws.dbPath)).toEqual(["ready_for_qa", "qa_passed"])
    const r = await beads.updateCustomStatuses(["qa_passed", "ready_for_qa"], ws.dbPath)
    expect(r).toEqual({ success: true })
    expect(await configValue()).toBe("qa_passed,ready_for_qa")
  })
})
