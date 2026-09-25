// beadId -> IDs of the issues that block it, from a `bd list --json` result
// (beadbox-01f.5). Shared by the blocked-by load and the tree build, which
// already has the list in hand (beadbox-w74). Lives outside lib/bd.ts because
// it never runs bd: bd.ts's exports are the argv surface the security census
// enumerates.

import type { BdBead } from "./bd"

export function blocksMapFromIssues(issues: BdBead[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const issue of issues) {
    for (const edge of issue.dependencies ?? []) {
      // Parent-child and related links are dependency rows too; only
      // blocks is a blocker. An edge with no target has nothing to show.
      if (edge.type !== "blocks" || !edge.depends_on_id) continue
      const existing = map.get(issue.id)
      if (existing) existing.push(edge.depends_on_id)
      else map.set(issue.id, [edge.depends_on_id])
    }
  }
  return map
}
