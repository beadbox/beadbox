// beadbox-ptca.1: the steps of a poured molecule with their children, built
// from one `bd mol show` document (no per-step or per-child bd call).
//
// bd 1.3 pours a nested formula as root -> step beads -> child beads through
// parent-child deps, and writes every need, in-step or cross-step, as a
// `blocks` dep (issue_id is blocked by depends_on_id). A flat formula's
// steps are parented to the root and carry their own blocks deps, so they
// come out with needs and no children.

import type { MolShowRaw } from "./bd"
import type { MoleculeStep, MoleculeStepNode } from "./types"

function groupBy(
  deps: MolShowRaw["dependencies"],
  type: string,
  key: "issue_id" | "depends_on_id",
) {
  const other = key === "issue_id" ? "depends_on_id" : "issue_id"
  const map = new Map<string, string[]>()
  for (const d of deps) {
    if (d.type !== type) continue
    const list = map.get(d[key]) ?? []
    list.push(d[other])
    map.set(d[key], list)
  }
  return map
}

export function buildMoleculeSteps(mol: MolShowRaw): MoleculeStep[] {
  const rootId = mol.root.id
  const issueById = new Map(mol.issues.map((i) => [i.id, i]))
  const childrenOf = groupBy(mol.dependencies, "parent-child", "depends_on_id")
  const needsOf = groupBy(mol.dependencies, "blocks", "issue_id")

  // Needs are kept only when they point at another bead of this molecule:
  // the root and outside beads have no node to draw an edge to.
  const node = (id: string): MoleculeStepNode | null => {
    const issue = issueById.get(id)
    if (!issue || id === rootId) return null
    const needs = (needsOf.get(id) ?? []).filter((n) => n !== rootId && issueById.has(n))
    return { id, title: issue.title, type: issue.issue_type, status: issue.status, needs }
  }
  const nodesUnder = (parentId: string) =>
    (childrenOf.get(parentId) ?? []).map(node).filter((n): n is MoleculeStepNode => n !== null)

  return nodesUnder(rootId).map((step) => ({ ...step, children: nodesUnder(step.id) }))
}
