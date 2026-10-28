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

// Each {{var}} matches any text (even none); the rest is literal and the whole
// title must match. No regex: a template with many placeholders against a long
// title backtracks for minutes, and a formula file is workspace content. For
// wildcard-only patterns, finding each literal at its leftmost position after
// the previous one is a correct match, and it is linear in the title length.
function matchesTemplate(template: string, title: string): boolean {
  const literals = template.split(/\{\{[^}]*\}\}/)
  if (literals.length === 1) return template === title
  const first = literals[0]!
  const last = literals[literals.length - 1]!
  if (title.length < first.length + last.length) return false
  if (!title.startsWith(first) || !title.endsWith(last)) return false
  const end = title.length - last.length
  let at = first.length
  for (const literal of literals.slice(1, -1)) {
    const found = title.indexOf(literal, at)
    if (found < 0 || found + literal.length > end) return false
    at = found + literal.length
  }
  return true
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
    (f, m) => matchesTemplate(f.title, m.title),
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
