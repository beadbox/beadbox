// lib/gates.ts: open gates and the issues they hold. The rows below are
// `bd list --status all --limit 0 --flat --include-gates --json` output from
// bd 1.3.1 (trimmed of fields the mapping does not read), produced by
//   bd gate create --type=human  --blocks <task> --reason="Need design review"
//   bd gate create --type=human  --blocks <epic> --title="Gate: owner sign-off"
//   bd gate create --type=timer  --blocks <task> --timeout=2h
//   bd gate create --type=gh:run --blocks <task> --await-id=123456789

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { BdBead } from "../lib/bd"
import * as gatesLib from "../lib/gates"
import { isOpenGate, resolveRefusal, waitingGates } from "../lib/gates"

const blocks = (issue: string, gate: string) => ({
  issue_id: issue,
  depends_on_id: gate,
  type: "blocks",
})
const childOf = (issue: string, parent: string) => ({
  issue_id: issue,
  depends_on_id: parent,
  type: "parent-child",
})

const ROWS = [
  {
    id: "gt-61f",
    title: "Gate: gh:run 123456789",
    description: "Ad-hoc gate blocking gt-6j9",
    status: "open",
    issue_type: "gate",
    created_at: "2026-10-20T11:51:32Z",
    await_type: "gh:run",
    await_id: "123456789",
  },
  {
    id: "gt-416",
    title: "Gate: timer",
    description: "Ad-hoc gate blocking gt-6j9",
    status: "open",
    issue_type: "gate",
    created_at: "2026-10-20T11:51:31Z",
    await_type: "timer",
    timeout: 7200000000000,
  },
  {
    id: "gt-epb",
    title: "Gate: owner sign-off",
    description: "Ad-hoc gate blocking gt-a6g",
    status: "open",
    issue_type: "gate",
    created_at: "2026-10-20T11:51:29Z",
    await_type: "human",
  },
  {
    id: "gt-nrv",
    title: "Gate: human",
    description: "Ad-hoc gate blocking gt-0jh\n\nReason: Need design review",
    status: "open",
    issue_type: "gate",
    created_at: "2026-10-20T11:51:28Z",
    await_type: "human",
  },
  {
    id: "gt-6j9",
    title: "Deploy",
    status: "open",
    issue_type: "task",
    created_at: "2026-10-20T11:51:27Z",
    dependencies: [blocks("gt-6j9", "gt-416"), blocks("gt-6j9", "gt-61f")],
  },
  {
    id: "gt-a6g.2",
    title: "Child B",
    status: "open",
    issue_type: "task",
    created_at: "2026-10-20T11:51:26Z",
    dependencies: [childOf("gt-a6g.2", "gt-a6g")],
    parent: "gt-a6g",
  },
  {
    id: "gt-a6g.1",
    title: "Child A",
    status: "open",
    issue_type: "task",
    created_at: "2026-10-20T11:51:24Z",
    dependencies: [childOf("gt-a6g.1", "gt-a6g")],
    parent: "gt-a6g",
  },
  {
    id: "gt-a6g",
    title: "Release epic",
    status: "open",
    issue_type: "epic",
    created_at: "2026-10-20T11:51:23Z",
    dependencies: [blocks("gt-a6g", "gt-epb")],
  },
  {
    id: "gt-0jh",
    title: "Ship feature",
    status: "open",
    issue_type: "task",
    created_at: "2026-10-20T11:51:22Z",
    dependencies: [blocks("gt-0jh", "gt-nrv")],
  },
  {
    id: "gt-587",
    title: "Unrelated",
    status: "open",
    issue_type: "task",
    created_at: "2026-10-20T11:51:15Z",
  },
]

const rows = (extra: object[] = []) => [...ROWS, ...extra] as unknown as BdBead[]
const byId = (id: string, list = waitingGates(rows())) => list.find((gate) => gate.id === id)

describe("waitingGates", () => {
  test("lists every open gate, oldest first", () => {
    expect(waitingGates(rows()).map((gate) => gate.id)).toEqual([
      "gt-nrv",
      "gt-epb",
      "gt-416",
      "gt-61f",
    ])
  })

  test("a task gate holds the task that depends on it", () => {
    expect(byId("gt-nrv")?.held).toEqual([
      { id: "gt-0jh", title: "Ship feature", status: "open", issueType: "task" },
    ])
  })

  test("an epic gate holds the epic and its children through the epic", () => {
    expect(byId("gt-epb")?.held).toEqual([
      { id: "gt-a6g", title: "Release epic", status: "open", issueType: "epic" },
      { id: "gt-a6g.1", title: "Child A", status: "open", issueType: "task", via: "gt-a6g" },
      { id: "gt-a6g.2", title: "Child B", status: "open", issueType: "task", via: "gt-a6g" },
    ])
  })

  test("grandchildren wait through the gated ancestor, closed descendants do not wait", () => {
    const list = waitingGates(
      rows([
        {
          id: "gt-a6g.1.1",
          title: "Grandkid",
          status: "open",
          issue_type: "task",
          created_at: "",
          parent: "gt-a6g.1",
        },
        {
          id: "gt-a6g.3",
          title: "Done",
          status: "closed",
          issue_type: "task",
          created_at: "",
          parent: "gt-a6g",
        },
      ]),
    )
    const held = byId("gt-epb", list)?.held ?? []
    expect(held.find((issue) => issue.id === "gt-a6g.1.1")?.via).toBe("gt-a6g")
    expect(held.some((issue) => issue.id === "gt-a6g.3")).toBe(false)
  })

  test("a parent-child edge without the parent field still counts", () => {
    const list = waitingGates(
      rows([
        {
          id: "gt-a6g.4",
          title: "Edge only",
          status: "open",
          issue_type: "task",
          created_at: "",
          dependencies: [childOf("gt-a6g.4", "gt-a6g")],
        },
      ]),
    )
    expect(byId("gt-epb", list)?.held.find((issue) => issue.id === "gt-a6g.4")?.via).toBe("gt-a6g")
  })

  test("one task can wait on two gates", () => {
    expect(byId("gt-416")?.held.map((issue) => issue.id)).toEqual(["gt-6j9"])
    expect(byId("gt-61f")?.held.map((issue) => issue.id)).toEqual(["gt-6j9"])
  })

  test("a timer gate carries its deadline; bd's timeout is nanoseconds", () => {
    const timer = byId("gt-416")
    expect(timer?.awaitType).toBe("timer")
    expect(timer?.timeoutMs).toBe(2 * 60 * 60 * 1000)
    expect(timer?.deadline).toBe("2026-10-20T13:51:31.000Z")
  })

  test("a gh:run gate carries its run id", () => {
    const run = byId("gt-61f")
    expect(run?.awaitType).toBe("gh:run")
    expect(run?.awaitId).toBe("123456789")
    expect(run?.deadline).toBeUndefined()
  })

  test("a human gate keeps bd's title and description", () => {
    const human = byId("gt-nrv")
    expect(human?.awaitType).toBe("human")
    expect(human?.title).toBe("Gate: human")
    expect(human?.description).toContain("Reason: Need design review")
    expect(human?.awaitId).toBeUndefined()
    expect(human?.timeoutMs).toBeUndefined()
  })

  test("closed gates and closed held issues are not waiting", () => {
    const list = waitingGates(
      rows([
        {
          id: "gt-old",
          title: "Gate: human",
          status: "closed",
          issue_type: "gate",
          created_at: "2026-01-01T00:00:00Z",
          await_type: "human",
        },
        {
          id: "gt-shipped",
          title: "Shipped",
          status: "closed",
          issue_type: "task",
          created_at: "",
          dependencies: [blocks("gt-shipped", "gt-nrv")],
        },
      ]),
    )
    expect(list.some((gate) => gate.id === "gt-old")).toBe(false)
    expect(byId("gt-nrv", list)?.held.map((issue) => issue.id)).toEqual(["gt-0jh"])
  })

  test("a gate that holds nothing is still listed", () => {
    const list = waitingGates(
      rows([
        {
          id: "gt-lone",
          title: "Gate: human",
          status: "open",
          issue_type: "gate",
          created_at: "2026-10-20T11:51:40Z",
          await_type: "human",
        },
      ]),
    )
    expect(byId("gt-lone", list)?.held).toEqual([])
  })

  test("sorts by instant across mixed timestamp precision", () => {
    const list = waitingGates([
      {
        id: "b",
        title: "",
        status: "open",
        issue_type: "gate",
        created_at: "2026-10-20T11:51:28.5Z",
      },
      {
        id: "a",
        title: "",
        status: "open",
        issue_type: "gate",
        created_at: "2026-10-20T11:51:28Z",
      },
      {
        id: "c",
        title: "",
        status: "open",
        issue_type: "gate",
        created_at: "2026-10-20T11:51:29Z",
      },
    ] as unknown as BdBead[])
    expect(list.map((gate) => gate.id)).toEqual(["a", "b", "c"])
  })

  test("no gates is an empty list", () => {
    expect(waitingGates([])).toEqual([])
  })

  // bd 1.3.1's `gate create --type` offers human, timer, gh:run and gh:pr
  // only; a bead gate comes from a formula step. Its row has the same shape,
  // with the awaited bead (here the cross-rig form) in await_id.
  test("a bead gate is listed like any other, with its awaited bead as given", () => {
    const bead = {
      id: "gt-b3d",
      title: "Gate: bead",
      description: "",
      status: "open",
      issue_type: "gate",
      created_at: "2026-10-20T11:51:30Z",
      await_type: "bead",
      await_id: "rig:gt-x9",
    }
    const list = waitingGates(rows([bead]))
    expect(list.map((gate) => gate.id)).toEqual(["gt-nrv", "gt-epb", "gt-b3d", "gt-416", "gt-61f"])
    expect(byId("gt-b3d", list)).toMatchObject({ awaitType: "bead", awaitId: "rig:gt-x9" })
  })
})

describe("isOpenGate (the Waiting tab's presence filter)", () => {
  const gate = (status: string, issue_type = "gate") =>
    ({ id: "g", title: "", status, issue_type, created_at: "" }) as unknown as BdBead

  test("an open or in-progress gate counts; closed, tombstoned or non-gate rows do not", () => {
    expect(isOpenGate(gate("open"))).toBe(true)
    expect(isOpenGate(gate("in_progress"))).toBe(true)
    expect(isOpenGate(gate("closed"))).toBe(false)
    expect(isOpenGate(gate("tombstone"))).toBe(false)
    expect(isOpenGate(gate("open", "task"))).toBe(false)
  })
})

// The checks resolveHumanGate makes on bd's fresh `bd show` answer. The
// real-bd cases are in gates-handler.unit.test.ts; tombstone has no
// `bd` command that produces it in 1.3.1, so it is pinned here.
describe("resolveRefusal", () => {
  const human = {
    id: "gt-epb",
    title: "Gate: human",
    status: "open",
    issue_type: "gate",
    created_at: "2026-10-20T11:51:29Z",
    await_type: "human",
  }
  const as = (patch: object) => ({ ...human, ...patch }) as unknown as BdBead

  test("an open human gate named by its exact ID may be resolved", () => {
    expect(resolveRefusal(as({}), "gt-epb")).toBeUndefined()
  })

  test("refuses a tombstoned gate", () => {
    expect(resolveRefusal(as({ status: "tombstone" }), "gt-epb")).toBe("gt-epb is already resolved")
  })

  test("refuses a closed gate", () => {
    expect(resolveRefusal(as({ status: "closed" }), "gt-epb")).toBe("gt-epb is already resolved")
  })

  test("refuses a missing issue or one bd matched by a shorter spelling", () => {
    expect(resolveRefusal(null, "gt-epb")).toBe("gt-epb not found")
    expect(resolveRefusal(as({}), "epb")).toBe("epb not found")
  })

  test("refuses an issue that is not a gate", () => {
    expect(resolveRefusal(as({ issue_type: "task" }), "gt-epb")).toBe("gt-epb is not a gate")
  })

  test("refuses every non-human gate type, and a gate with no type", () => {
    for (const type of ["timer", "gh:run", "gh:pr", "bead"]) {
      expect(resolveRefusal(as({ await_type: type }), "gt-epb")).toBe(
        `gt-epb is a ${type} gate, not a human gate`,
      )
    }
    expect(resolveRefusal(as({ await_type: undefined }), "gt-epb")).toBe(
      "gt-epb is a non-human gate, not a human gate",
    )
  })
})

// Hostile repository content (beadbox-sun, sec FIX-1): a workspace decides how
// many gates block how many issues with how many descendants. Without bounds the
// held lists grow as gates x descendants, and a few MB of .beads/ ran the
// sidecar out of memory. The limits are spec section 4.11's, written out here so the
// cases fail on the count, not on a missing export.
describe("held lists are bounded (hostile workspace)", () => {
  const PER_GATE = 200
  const TOTAL = 5000

  const gateRow = (i: number) => ({
    id: `hg-${String(i).padStart(4, "0")}`,
    title: "Gate: human",
    status: "open",
    issue_type: "gate",
    created_at: new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString(),
    await_type: "human",
  })

  // `gates` gates all blocking one epic that has `children` open children.
  function fanOut(gates: number, children: number): BdBead[] {
    const out: object[] = []
    for (let g = 0; g < gates; g++) out.push(gateRow(g))
    out.push({
      id: "he-epic",
      title: "Epic",
      status: "open",
      issue_type: "epic",
      created_at: "",
      dependencies: Array.from({ length: gates }, (_, g) => blocks("he-epic", gateRow(g).id)),
    })
    for (let c = 0; c < children; c++) {
      out.push({
        id: `he-epic.${c}`,
        title: `Child ${c}`,
        status: "open",
        issue_type: "task",
        created_at: "",
        parent: "he-epic",
      })
    }
    return out as unknown as BdBead[]
  }

  test("the limits are named constants: 200 per gate, 5,000 in all", () => {
    expect(gatesLib.HELD_PER_GATE_CAP).toBe(PER_GATE)
    expect(gatesLib.HELD_TOTAL_BUDGET).toBe(TOTAL)
  })

  test("300 gates on one epic with 1,000 children: every gate listed, held within both bounds", () => {
    const list = waitingGates(fanOut(300, 1000))
    expect(list).toHaveLength(300)
    const total = list.reduce((n, gate) => n + gate.held.length, 0)
    expect(total).toBeLessThanOrEqual(TOTAL)
    for (const gate of list) expect(gate.held.length).toBeLessThanOrEqual(PER_GATE)
    // Oldest first: the first 25 gates fill the budget at 200 each, the rest get none.
    expect(list.slice(0, 25).every((gate) => gate.held.length === PER_GATE)).toBe(true)
    expect(list.slice(25).every((gate) => gate.held.length === 0)).toBe(true)
    // Every gate lost part of its list, so every gate says so.
    expect(list.every((gate) => gate.heldTruncated === true)).toBe(true)
  })

  test("the per-gate cap stops one gate's walk; the epic itself comes first", () => {
    const [gate] = waitingGates(fanOut(1, 1000))
    expect(gate?.held).toHaveLength(PER_GATE)
    expect(gate?.held[0]?.id).toBe("he-epic")
    expect(gate?.heldTruncated).toBe(true)
  })

  test("5,000 issues blocking one gate directly: the cap holds", () => {
    const rowsOut: object[] = [gateRow(0)]
    for (let i = 0; i < 5000; i++) {
      rowsOut.push({
        id: `hd-${i}`,
        title: "",
        status: "open",
        issue_type: "task",
        created_at: "",
        dependencies: [blocks(`hd-${i}`, gateRow(0).id)],
      })
    }
    const [gate] = waitingGates(rowsOut as unknown as BdBead[])
    expect(gate?.held).toHaveLength(PER_GATE)
    expect(gate?.heldTruncated).toBe(true)
  })

  test("a gate within both bounds carries no truncation flag", () => {
    for (const gate of waitingGates(rows())) expect(gate.heldTruncated).toBeUndefined()
  })

  // The view quotes the budget when it is used up; its copy must not drift.
  test("the client's quoted budget is this one", () => {
    const client = readFileSync(
      join(import.meta.dir, "..", "..", "..", "client", "src", "lib", "waiting.ts"),
      "utf-8",
    )
    expect(client).toContain(`export const HELD_TOTAL_BUDGET = ${gatesLib.HELD_TOTAL_BUDGET}\n`)
  })

  test("after the budget is spent, a gate that holds nothing is not marked truncated", () => {
    const list = waitingGates([
      ...fanOut(30, 1000),
      { ...gateRow(99), id: "hg-empty" },
    ] as unknown as BdBead[])
    const empty = list.find((gate) => gate.id === "hg-empty")
    expect(empty?.held).toEqual([])
    expect(empty?.heldTruncated).toBeUndefined()
  })
})
