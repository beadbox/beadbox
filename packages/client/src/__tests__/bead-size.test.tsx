// beadbox-9d4: each bead row shows its T-shirt size (XS/S/M/L) where the
// estimate stopwatch sat; a bead with no estimate shows a plain "unsized" mark.

import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render, screen, within } from "@testing-library/react"
import { BeadTable } from "../components/bead-table"
import { TooltipProvider } from "../components/ui/tooltip"
import { type BeadSize, beadSize, SIZE_THRESHOLDS, sizeForMinutes } from "../lib/bead-size"
import type { Bead } from "../lib/types"

afterEach(cleanup)

const bead = (id: string, extra: Partial<Bead> = {}): Bead => ({
  id,
  title: `Title ${id}`,
  type: "task",
  description: "",
  status: "open",
  priority: "medium",
  assignee: "",
  comments: [],
  ...extra,
})

describe("size mapping (thresholds in one place)", () => {
  test("boundaries: 14 XS, 15 S, 59 S, 60 M, 180 M, 181 L", () => {
    expect(SIZE_THRESHOLDS).toEqual({ xsBelow: 15, sBelow: 60, mUpTo: 180 })
    const cases: [number, BeadSize][] = [
      [1, "XS"],
      [14, "XS"],
      [15, "S"],
      [59, "S"],
      [60, "M"],
      [180, "M"],
      [181, "L"],
      [2000, "L"],
    ]
    for (const [minutes, size] of cases) expect(sizeForMinutes(minutes)).toBe(size)
  })

  test("missing, zero, negative and non-finite estimates are unsized, never guessed", () => {
    for (const estimatedMinutes of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const info = beadSize(bead("u", { estimatedMinutes }))
      expect(info.size).toBeNull()
      expect(info.label).toBe("Unsized: no estimate")
      expect(info.tooltip).toBe("No estimate")
    }
  })

  test("a revised estimate in metadata overrides the original", () => {
    const info = beadSize(bead("r", { estimatedMinutes: 60, metadata: { estimate_revised_min: 240 } }))
    expect(info).toMatchObject({ size: "L", minutes: 240, revised: true })
    expect(info.label).toBe("Size L, about 4h (revised)")
    expect(info.tooltip).toBe("~4h (revised)")
    // bd may hand metadata values back as numeric strings
    expect(beadSize(bead("s", { estimatedMinutes: 200, metadata: { estimate_revised_min: "30" } }))).toMatchObject({
      size: "S",
      minutes: 30,
      revised: true,
    })
    // a revision with no original estimate still sizes the bead
    expect(beadSize(bead("o", { metadata: { estimate_revised_min: 10 } }))).toMatchObject({ size: "XS", revised: true })
  })

  test("malformed revised metadata falls back to the original estimate", () => {
    for (const estimate_revised_min of ["soon", "", "12abc", 0, -30, null, {}, [], Number.NaN]) {
      const info = beadSize(bead("m", { estimatedMinutes: 120, metadata: { estimate_revised_min } }))
      expect(info).toMatchObject({ size: "M", minutes: 120, revised: false })
      expect(info.label).toBe("Size M, about 2h")
    }
    // malformed revision and no original: unsized
    expect(beadSize(bead("n", { metadata: { estimate_revised_min: "x" } })).size).toBeNull()
  })

  test("tooltip keeps today's ~Nm / ~Nh figure", () => {
    expect(beadSize(bead("a", { estimatedMinutes: 45 })).tooltip).toBe("~45m")
    expect(beadSize(bead("b", { estimatedMinutes: 90 })).tooltip).toBe("~2h")
    expect(beadSize(bead("c", { estimatedMinutes: 45 })).label).toBe("Size S, about 45m")
  })
})

describe("size badge in bead rows", () => {
  function table(beads: Bead[], extra: Partial<Parameters<typeof BeadTable>[0]> = {}) {
    return render(
      <TooltipProvider>
        <BeadTable beads={beads} epicId="e" onBeadClick={() => {}} {...extra} />
      </TooltipProvider>,
    )
  }
  const rowOf = (id: string) => document.querySelector(`[data-item-id="${id}"]`) as HTMLElement

  test("every row shows a visible size badge or the unsized mark", () => {
    table([
      bead("xs", { estimatedMinutes: 10 }),
      bead("l", { estimatedMinutes: 300 }),
      bead("rev", { estimatedMinutes: 30, metadata: { estimate_revised_min: 120 } }),
      bead("none"),
    ])
    const xs = within(rowOf("xs")).getByRole("img", { name: "Size XS, about 10m" })
    expect(xs.textContent).toBe("XS")
    expect(within(rowOf("l")).getByRole("img", { name: "Size L, about 5h" }).textContent).toBe("L")
    expect(within(rowOf("rev")).getByRole("img", { name: "Size M, about 2h (revised)" }).textContent).toBe("M")
    const unsized = within(rowOf("none")).getByRole("img", { name: "Unsized: no estimate" })
    expect(unsized.textContent).toBe("?")
  })

  test("a closed bead keeps its badge", () => {
    table([bead("done", { status: "closed", estimatedMinutes: 90 })])
    expect(within(rowOf("done")).getByRole("img", { name: "Size M, about 2h" })).toBeTruthy()
  })

  test("nested child rows show their own badge", () => {
    const child = bead("parent.1", { estimatedMinutes: 20 })
    table([bead("parent", { estimatedMinutes: 500, children: [child] })], {
      expandedBeads: new Set(["parent"]),
      onToggleBead: () => {},
    })
    expect(within(rowOf("parent")).getAllByRole("img", { name: /^Size/ })[0].getAttribute("aria-label")).toBe(
      "Size L, about 8h",
    )
    expect(within(rowOf("parent.1")).getByRole("img", { name: "Size S, about 20m" })).toBeTruthy()
  })

  test("All projects rows (sourceForBead) show it the same way", () => {
    table([bead("p1", { estimatedMinutes: 5 }), bead("p2")], {
      flat: true,
      epicId: "_all",
      sourceForBead: () => ({ id: "ws", name: "Project" }),
    })
    expect(screen.getByRole("img", { name: "Size XS, about 5m" })).toBeTruthy()
    expect(screen.getByRole("img", { name: "Unsized: no estimate" })).toBeTruthy()
  })
})
