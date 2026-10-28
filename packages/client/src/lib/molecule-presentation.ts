import type { Bead } from "./types"

/**
 * Legacy formula roots use an epic issue type with a molecule-shaped ID. A
 * "-mol-" epic WITH a parent is a step of a nested molecule (bd 1.3 pours its
 * step epics under the workspace's -mol- prefix), so it is a phase of that
 * molecule, never a molecule of its own (beadbox-e04o.1).
 */
export function isMoleculePresentation(bead: Pick<Bead, "id" | "type" | "parentId">): boolean {
  return bead.type === "molecule" || (bead.type === "epic" && bead.id.includes("-mol-") && !bead.parentId)
}
