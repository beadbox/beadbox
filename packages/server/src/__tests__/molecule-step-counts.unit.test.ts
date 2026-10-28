// closed/total per step (beadbox-ptca.4). A poured bead carries no link to its
// formula step, so steps are matched by title: the formula title is the
// template ("{{who}}"), the bead title is resolved. The molecule's step order
// is not the formula's, so position is never used.

import { describe, expect, test } from "bun:test"
import { buildStepCounts } from "../lib/molecule-step-counts"
import type { FormulaStep, MoleculeStep, MoleculeStepNode } from "../lib/types"

const fstep = (id: string, title: string): FormulaStep => ({ id, title, type: "task" })
const child = (id: string, status: string): MoleculeStepNode => ({
  id,
  title: id,
  type: "task",
  status,
  needs: [],
})
const mstep = (id: string, title: string, children: MoleculeStepNode[]): MoleculeStep => ({
  id,
  title,
  type: children.length ? "epic" : "task",
  status: "open",
  needs: [],
  children,
})

describe("buildStepCounts (beadbox-ptca.4)", () => {
  test("closed/total from the children's real status", () => {
    const counts = buildStepCounts(
      [fstep("s1", "Build")],
      [
        mstep("m-1", "Build", [
          child("a", "closed"),
          child("b", "closed"),
          child("c", "closed"),
          child("d", "open"),
          child("e", "in_progress"),
          child("f", "blocked"),
          child("g", "deferred"),
        ]),
      ],
    )
    expect(counts).toEqual({ s1: { closed: 3, total: 7 } })
  })

  test("a step with zero children in a nested formula is 0/0", () => {
    const counts = buildStepCounts(
      [fstep("s1", "Step 1"), fstep("s3", "Step 3: empty")],
      [mstep("m-1", "Step 1", [child("a", "open")]), mstep("m-3", "Step 3: empty", [])],
    )
    expect(counts).toEqual({ s1: { closed: 0, total: 1 }, s3: { closed: 0, total: 0 } })
  })

  test("a templated formula title matches its resolved bead", () => {
    const counts = buildStepCounts(
      [fstep("s1", "Step 1: {{who}} prepares {{what}}")],
      [mstep("m-1", "Step 1: bob prepares v0.18.0", [child("a", "closed")])],
    )
    expect(counts).toEqual({ s1: { closed: 1, total: 1 } })
  })

  test("the molecule's step order does not decide the match", () => {
    const counts = buildStepCounts(
      [fstep("s1", "Step 1"), fstep("s2", "Step 2"), fstep("s3", "Step 3")],
      [
        mstep("m-1", "Step 1", [child("a", "closed"), child("b", "open")]),
        mstep("m-3", "Step 3", []),
        mstep("m-2", "Step 2", [child("c", "closed")]),
      ],
    )
    expect(counts).toEqual({
      s1: { closed: 1, total: 2 },
      s2: { closed: 1, total: 1 },
      s3: { closed: 0, total: 0 },
    })
  })

  test("template text is literal outside the placeholders", () => {
    // "." and "(" are not pattern syntax: "Step 1.x (a)" must not match "Step 1zx (a)".
    const counts = buildStepCounts(
      [fstep("s1", "Step 1.x (a)")],
      [mstep("m-1", "Step 1zx (a)", [child("a", "closed")])],
    )
    expect(counts).toEqual({})
  })

  test("two steps with the same template are matched in formula order, each bead once", () => {
    const counts = buildStepCounts(
      [fstep("r1", "Review {{a}}"), fstep("r2", "Review {{b}}")],
      [
        mstep("m-1", "Review x", [child("a", "closed")]),
        mstep("m-2", "Review y", [child("b", "open")]),
      ],
    )
    expect(counts).toEqual({ r1: { closed: 1, total: 1 }, r2: { closed: 0, total: 1 } })
  })

  test("an exact title wins over a template match for the same bead", () => {
    const counts = buildStepCounts(
      [fstep("t", "Ship {{v}}"), fstep("e", "Ship docs")],
      [
        mstep("m-docs", "Ship docs", [child("a", "closed")]),
        mstep("m-v", "Ship v1", [child("b", "open")]),
      ],
    )
    expect(counts).toEqual({ t: { closed: 0, total: 1 }, e: { closed: 1, total: 1 } })
  })

  test("a formula step with no matching bead has no count", () => {
    expect(
      buildStepCounts([fstep("s1", "Gone")], [mstep("m-1", "Other", [child("a", "closed")])]),
    ).toEqual({})
  })

  test("a flat formula (no step has children) shows no counts at all", () => {
    // super on beadbox-ptca.4, 2026-10-28: 0/0 on every step of a flat formula is noise.
    const counts = buildStepCounts(
      [fstep("s1", "Step 1"), fstep("s2", "Step 2")],
      [mstep("m-1", "Step 1", []), mstep("m-2", "Step 2", [])],
    )
    expect(counts).toEqual({})
  })

  test("no molecule steps: no counts", () => {
    expect(buildStepCounts([fstep("s1", "Step 1")], [])).toEqual({})
  })
})
