// beadbox-ptca.4: closed/total per step, from the selected molecule's
// children (ptca.1's buildMoleculeSteps). A poured bead carries no link to its
// formula step and `bd mol show` gives no variables, so steps are matched by
// title: the formula title is the template ("Step 1: {{who}} prepares"), the
// bead title is resolved ("Step 1: bob prepares"). The molecule's step order
// differs from the formula's, so position is never used.
//
// A flat formula (no step has children) gets no counts: 0/0 on every step is
// noise (super, 2026-10-28). Inside a nested formula a zero-child step is 0/0.

import type { FormulaStep, MoleculeStep, StepCount } from "./types"

// Anchored; each {{var}} matches any text, everything else is literal.
function titlePattern(template: string): RegExp {
  const literal = template
    .split(/\{\{[^}]*\}\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`^${literal.join(".*")}$`, "s")
}

export function buildStepCounts(
  formulaSteps: FormulaStep[],
  molSteps: MoleculeStep[],
): Record<string, StepCount> {
  if (!molSteps.some((s) => s.children.length > 0)) return {}

  const matched = new Map<string, MoleculeStep>()
  const used = new Set<string>()
  // Exact titles first, so a templated step cannot take a bead an exact one names.
  const passes: Array<(f: FormulaStep, m: MoleculeStep) => boolean> = [
    (f, m) => m.title === f.title,
    (f, m) => titlePattern(f.title).test(m.title),
  ]
  for (const fits of passes) {
    for (const f of formulaSteps) {
      if (matched.has(f.id)) continue
      const m = molSteps.find((s) => !used.has(s.id) && fits(f, s))
      if (!m) continue
      matched.set(f.id, m)
      used.add(m.id)
    }
  }

  const counts: Record<string, StepCount> = {}
  for (const [id, m] of matched) {
    counts[id] = {
      closed: m.children.filter((c) => c.status === "closed").length,
      total: m.children.length,
    }
  }
  return counts
}
