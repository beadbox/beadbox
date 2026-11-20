// The 3D molecule graph keys its own node palette off "has the user chosen a
// colour for this status". The palette sweep made every status emit a
// stylesheet rule, so the store's `css` became always-populated and that
// fallback was unreachable: with nothing chosen in Settings, in_progress went
// blue -> amber and closed went green -> zinc, silently, for every workspace.
// getNodeColor now reads `chosen` instead.
import { describe, expect, test } from "bun:test"
import { getNodeColor } from "../components/molecule-dag"
import { BUILTIN_STATUSES, resolveStatusColors } from "../lib/status-colors"

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`

describe("getNodeColor", () => {
  const { chosen, css } = resolveStatusColors([...BUILTIN_STATUSES], {})

  test("with nothing chosen it uses the graph's own palette", () => {
    expect(hex(getNodeColor({ type: "task", status: "in_progress" }, chosen))).toBe("#3b82f6")
    expect(hex(getNodeColor({ type: "task", status: "closed" }, chosen))).toBe("#22c55e")
    expect(hex(getNodeColor({ type: "task", status: "blocked" }, chosen))).toBe("#6b7280")
  })

  // The regression guard: `css` is populated for every status, so passing it
  // would override the palette on a workspace that chose nothing.
  test("passing css instead of chosen would break that", () => {
    expect(hex(getNodeColor({ type: "task", status: "in_progress" }, css))).not.toBe("#3b82f6")
  })

  test("a chosen colour still wins", () => {
    const picked = resolveStatusColors([...BUILTIN_STATUSES], { in_progress: "#ff0000" })
    expect(hex(getNodeColor({ type: "task", status: "in_progress" }, picked.chosen))).toBe("#ff0000")
  })

  test("gates keep their own state colours regardless", () => {
    expect(hex(getNodeColor({ type: "gate", status: "closed" }, chosen))).toBe("#22c55e")
    expect(hex(getNodeColor({ type: "gate", status: "open" }, chosen))).toBe("#f59e0b")
  })
})
