import { collectAllBeadsFromEpics } from "./epic-tree-utils"
import type { Bead, Epic, WorkspaceCard } from "./types"

export interface ProjectSnapshot {
  workspace: WorkspaceCard
  epics: Epic[]
  error?: string
}

export interface ProjectBead {
  key: string
  workspace: WorkspaceCard
  bead: Bead
}

export function projectBeadKey(workspaceId: string, beadId: string): string {
  return JSON.stringify([workspaceId, beadId])
}

export function projectBeads(snapshot: ProjectSnapshot): ProjectBead[] {
  const seen = new Set<string>()
  return collectAllBeadsFromEpics(snapshot.epics)
    .filter((bead) => {
      if (bead.id === "_standalone" || seen.has(bead.id)) return false
      seen.add(bead.id)
      return true
    })
    .map((bead) => ({
      key: projectBeadKey(snapshot.workspace.id, bead.id),
      workspace: snapshot.workspace,
      bead,
    }))
}

/** At most two sources in flight; no next cycle until this one has settled. */
export async function readProjects<T>(
  items: readonly T[],
  read: (item: T) => Promise<void>,
  cancelled: () => boolean,
) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(2, items.length) }, async () => {
      while (!cancelled() && next < items.length) {
        const item = items[next++]
        await read(item)
      }
    }),
  )
}
