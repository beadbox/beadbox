// beadbox-ptca.2: the Formulas tab graph lays out a nested formula as one
// container per step, its children inside in dependency order. Before this,
// the six steps (no step-level needs, all needs on children) collapsed into a
// single PARALLEL group and the children never rendered.
//
// The flat-formula golden was captured from the layout before this change, so
// "flat formulas lay out as today" is checked against the old code's output.

import { describe, expect, test } from "bun:test"
import { layoutFormulaSteps } from "../components/formula-dag"
import { orderChildren } from "../lib/formula-nesting"
import type { FormulaStep } from "../lib/types"
import golden from "./__golden__/formula-dag-flat.json"
import {
  flatFormula,
  layoutShape,
  NESTED_CHILD_ORDER,
  nestedFormula,
  parallelFormula,
} from "./formula-fixtures"

type NestedData = {
  step: FormulaStep
  stepIndex: number
  children: FormulaStep[]
  size: { width: number; height: number }
}

describe("layoutFormulaSteps on a nested formula", () => {
  test("each step is its own container holding its children in dependency order", async () => {
    const { nodes } = await layoutFormulaSteps(nestedFormula())
    const groups = nodes.filter((n) => n.type === "nestedStep")
    expect(groups.map((n) => n.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"])
    for (const n of groups) {
      const data = n.data as unknown as NestedData
      expect(data.children.map((c) => c.id)).toEqual(NESTED_CHILD_ORDER[n.id])
    }
  })

  test("steps whose needs live on their children do not collapse into a PARALLEL block", async () => {
    const { nodes } = await layoutFormulaSteps(nestedFormula())
    expect(nodes.filter((n) => n.type === "stepGroup")).toHaveLength(0)
    expect(nodes.map((n) => n.type).sort()).toEqual([
      "nestedStep",
      "nestedStep",
      "nestedStep",
      "nestedStep",
      "nestedStep",
      "nestedStep",
      "terminal",
      "terminal",
    ])
  })

  test("containers do not overlap", async () => {
    const { nodes } = await layoutFormulaSteps(nestedFormula())
    const boxes = nodes
      .filter((n) => n.type === "nestedStep")
      .map((n) => {
        const { size } = n.data as unknown as NestedData
        return { id: n.id, x: n.position.x, y: n.position.y, w: size.width, h: size.height }
      })
    expect(boxes).toHaveLength(6)
    for (const b of boxes) expect(b.h).toBeGreaterThan(0)
    for (const a of boxes)
      for (const b of boxes) {
        if (a.id >= b.id) continue
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(apart).toBe(true)
      }
  })

  test("a step with zero children renders as an empty container", async () => {
    const steps = [...nestedFormula(), { id: "s7", title: "Step s7", type: "epic" }]
    const { nodes } = await layoutFormulaSteps(steps)
    const empty = nodes.find((n) => n.id === "s7")
    expect(empty?.type).toBe("nestedStep")
    expect((empty?.data as unknown as NestedData).children).toEqual([])
  })
})

describe("layoutFormulaSteps on flat formulas (unchanged)", () => {
  test("a flat formula lays out exactly as before", async () => {
    expect(layoutShape(await layoutFormulaSteps(flatFormula()))).toEqual(golden.flat)
  })

  test("a real parallel set still groups as PARALLEL, exactly as before", async () => {
    const shape = layoutShape(await layoutFormulaSteps(parallelFormula()))
    expect(shape).toEqual(golden.parallel)
    expect(shape.nodes.find((n) => n.type === "stepGroup")?.members).toEqual([
      "lint",
      "unit",
      "e2e",
    ])
  })
})

describe("orderChildren", () => {
  const t = (id: string, needs?: string[]): FormulaStep => ({ id, title: id, type: "task", needs })

  test("orders by needs, ties in formula order", () => {
    const r = orderChildren([t("c", ["a"]), t("b"), t("a"), t("d", ["b"])])
    expect(r.ordered.map((c) => c.id)).toEqual(["b", "a", "c", "d"])
    expect(r.cyclic).toEqual([])
  })

  test("a need outside the step is ignored for ordering", () => {
    const r = orderChildren([t("y", ["x"]), t("x", ["elsewhere"])])
    expect(r.ordered.map((c) => c.id)).toEqual(["x", "y"])
  })

  test("a cycle is reported and appended in formula order, not looped on", () => {
    const r = orderChildren([t("p", ["q"]), t("ok"), t("q", ["p"]), t("after", ["ok"])])
    expect(r.ordered.map((c) => c.id)).toEqual(["ok", "after", "p", "q"])
    expect(r.cyclic).toEqual(["p", "q"])
  })

  test("no children gives an empty order", () => {
    expect(orderChildren([])).toEqual({ ordered: [], cyclic: [] })
  })
})
