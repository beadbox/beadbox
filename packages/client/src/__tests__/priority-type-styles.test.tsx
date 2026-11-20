// The sweep moved priority and bead-type colour out of per-component Tailwind
// classes into a stylesheet. StatusColorsMount, which used to render it, sits
// inside __root.tsx's NON-aggregate branch — so on /all-projects every type
// badge fell back to the neutral TYPE_BADGE_CLASS and the priority ramp
// collapsed onto the tones. The sheet is now its own component, mounted once
// outside that branch.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, render } from "@testing-library/react"
import { afterEach } from "bun:test"
import { PriorityTypeStyles } from "../components/status-colors-mount"

afterEach(cleanup)

describe("PriorityTypeStyles", () => {
  test("emits distinct priority hues and every bead type", () => {
    render(<PriorityTypeStyles />)
    const css = document.querySelector("[data-beadbox-status-colors-shared]")?.textContent ?? ""
    expect(css).toContain('[data-priority="critical"][data-priority-role="badge"]')
    // P0 red at /20, P2 yellow at half that: the ramp survives.
    expect(css).toContain("rgb(239 68 68 / 0.2)")
    expect(css).toContain("rgb(234 179 8 / 0.1)")
    expect(css).toContain('[data-type="bug"][data-type-role="badge"]')
    // epic-tree's icons use the text role, not badge.
    expect(css).toContain('[data-type="molecule"][data-type-role="text"]')
    // Unscoped: these are not per project.
    expect(css).not.toContain("data-project-id")
  })

  // The regression guard. It is placement, not content, that broke before:
  // the sheet must be rendered OUTSIDE the `aggregate ? ... : <StartupGate>`
  // ternary, or /all-projects loses it again.
  test("__root mounts it outside the aggregate branch", () => {
    const root = readFileSync(join(import.meta.dir, "..", "routes", "__root.tsx"), "utf-8")
    const mount = root.indexOf("<PriorityTypeStyles />")
    const branch = root.indexOf("{aggregate ?")
    expect(mount).toBeGreaterThan(-1)
    expect(branch).toBeGreaterThan(-1)
    expect(mount).toBeLessThan(branch)
  })

  // And it must not be derived twice: that duplication is what colorRules()
  // was extracted to prevent.
  test("only one component builds the priority/type sheet", () => {
    const dir = join(import.meta.dir, "..")
    const files = [
      join(dir, "components", "status-colors-mount.tsx"),
      join(dir, "components", "project-status-colors.tsx"),
    ]
    const callers = files.filter((f) => readFileSync(f, "utf-8").includes("buildTypeColorCss("))
    expect(callers).toHaveLength(1)
  })
})
