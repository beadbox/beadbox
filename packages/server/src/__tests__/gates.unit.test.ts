// lib/gates.ts: open gates and the issues they hold. The rows below are
// `bd list --status all --limit 0 --flat --include-gates --json` output from
// bd 1.3.1 (trimmed of fields the mapping does not read), produced by
//   bd gate create --type=human  --blocks <task> --reason="Need design review"
//   bd gate create --type=human  --blocks <epic> --title="Gate: owner sign-off"
//   bd gate create --type=timer  --blocks <task> --timeout=2h
//   bd gate create --type=gh:run --blocks <task> --await-id=123456789

import { describe, expect, test } from "bun:test"
import type { BdBead } from "../lib/bd"
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
