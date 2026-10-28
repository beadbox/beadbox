// beadbox-e04o.3: a nested molecule's steps in the plan's order, and each
// step's children in dependency order. bd 1.3.1 pours both edge shapes: a
// step's own needs is a blocks edge between step epics (step.blockedBy), and
// a child's cross-step needs is a blocks edge between the children only
// (child.blockedBy names another step's child). Own edges win where present;
// children's edges order the rest; pour order breaks ties; cycle members keep
// pour order and go last. The view (computeStepGroups) and the keyboard walk
// both take this order from orderMoleculeSteps.

import { describe, expect, test } from "bun:test"
import { orderChildren } from "../lib/formula-nesting"
import { computeStepGroups } from "../lib/molecule-phases"
import { orderMoleculeSteps } from "../lib/molecule-order"
import type { Bead, Epic, FormulaStep } from "../lib/types"

const dep = (id: string) => ({ id, title: id })
const task = (id: string, needs: string[] = []): Bead =>
  ({ id, title: id, type: "task", status: "open", blockedBy: needs.map(dep) }) as unknown as Bead
const step = (id: string, children: Bead[], needs: string[] = []): Epic =>
  ({
    id,
    title: id,
    type: "epic",
    status: "open",
    parentId: "root",
    blockedBy: needs.map(dep),
    children,
    childEpics: [],
  }) as unknown as Epic

const stepIds = (steps: Epic[]) => computeStepGroups(steps).map((g) => g.step.id)
const rowIds = (steps: Epic[], id: string) =>
  computeStepGroups(steps)
    .find((g) => g.step.id === id)
    ?.rows.map((r) => r.id)

describe("step order (beadbox-e04o.3)", () => {
  test("own edges: a step that needs another comes after it", () => {
    // Poured s2, s1, s3; s2 needs s1.
    const steps = [step("s2", [], ["s1"]), step("s1", []), step("s3", [])]
    expect(stepIds(steps)).toEqual(["s1", "s2", "s3"])
  })

  test("cross-step children only: the step holding the needed child comes first", () => {
    // Poured s1, s2, s3. No step has an edge of its own; s1's child needs a
    // child of s2. s3 has no edge either way and keeps its pour slot.
    const steps = [step("s1", [task("a", ["c"])]), step("s2", [task("c")]), step("s3", [task("e")])]
    expect(stepIds(steps)).toEqual(["s2", "s1", "s3"])
  })

  test("mixed: own edges win over a contradicting children's edge; children's edges order the rest", () => {
    // Own: s2 needs s1. A child of s1 needs a child of s2 (derived s2 -> s1,
    // which contradicts the own edge and is dropped). A child of s4 needs a
    // child of s3 (derived s3 -> s4, the only thing ordering those two).
    const steps = [
      step("s4", [task("d", ["c"])]),
      step("s1", [task("a", ["b"])]),
      step("s2", [task("b")], ["s1"]),
      step("s3", [task("c")]),
    ]
    const order = stepIds(steps)
    expect(order.indexOf("s1")).toBeLessThan(order.indexOf("s2"))
    expect(order.indexOf("s3")).toBeLessThan(order.indexOf("s4"))
    expect(order).toEqual(["s1", "s2", "s3", "s4"])
  })

  test("a step cycle keeps pour order for its members and lists them last, without looping", () => {
    const steps = [step("x", [], ["y"]), step("free", []), step("y", [], ["x"])]
    expect(stepIds(steps)).toEqual(["free", "x", "y"])
  })

  test("a need on a bead outside the molecule orders nothing and does not crash", () => {
    const steps = [step("s1", [task("a", ["elsewhere-1"])], ["elsewhere-2"]), step("s2", [task("b")])]
    expect(stepIds(steps)).toEqual(["s1", "s2"])
    expect(rowIds(steps, "s1")).toEqual(["a"])
  })
})

describe("children order inside a step (beadbox-e04o.3)", () => {
  test("children follow their in-step needs, ties in pour order", () => {
    // Poured c, a, b; c needs b, b needs a.
    const steps = [step("s1", [task("c", ["b"]), task("a"), task("b", ["a"])])]
    expect(rowIds(steps, "s1")).toEqual(["a", "b", "c"])
  })

  test("a need on another step's child does not reorder within the step", () => {
    const steps = [step("s1", [task("x", ["z"]), task("y")]), step("s2", [task("z")])]
    expect(rowIds(steps, "s1")).toEqual(["x", "y"])
  })

  test("a children's cycle keeps pour order for its members, listed last", () => {
    const steps = [step("s1", [task("p", ["q"]), task("free"), task("q", ["p"])])]
    expect(rowIds(steps, "s1")).toEqual(["free", "p", "q"])
  })

  test("gate badges survive the reorder", () => {
    const gate = { ...task("g"), type: "gate", gateWait: { awaitType: "human" } } as unknown as Bead
    const steps = [step("s1", [task("b", ["g"]), gate])]
    const rows = computeStepGroups(steps)[0]!.rows
    expect(rows.map((r) => r.id)).toEqual(["g", "b"])
    expect(rows.find((r) => r.id === "b")?.gate?.type).toBe("human")
  })
})

describe("one order for the view and the walk (beadbox-e04o.3)", () => {
  test("computeStepGroups and orderMoleculeSteps give the same steps and children", () => {
    const steps = [step("s1", [task("a", ["c"]), task("a2", ["a"])]), step("s2", [task("c")])]
    const view = computeStepGroups(steps).map((g) => [g.step.id, g.rows.map((r) => r.id)])
    const walk = orderMoleculeSteps(steps).map((g) => [g.step.id, g.children.map((c) => c.id)])
    expect(view).toEqual(walk)
  })

  test("children's order agrees with the Formulas tab's orderChildren on the same shape", () => {
    const shape: Array<[string, string[]]> = [["c", ["b"]], ["a", []], ["b", ["a"]], ["p", ["q"]], ["q", ["p"]]]
    const tree = orderMoleculeSteps([step("s1", shape.map(([id, needs]) => task(id, needs)))])[0]!.children
    const formula = orderChildren(shape.map(([id, needs]) => ({ id, title: id, needs }) as FormulaStep)).ordered
    expect(tree.map((c) => c.id)).toEqual(formula.map((c) => c.id))
  })
})
