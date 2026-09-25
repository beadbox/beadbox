import type { Bead } from "./types"

/** Legacy formula roots use an epic issue type with a molecule-shaped ID. */
export function isMoleculePresentation(bead: Pick<Bead, "id" | "type">): boolean {
  return bead.type === "molecule" || (bead.type === "epic" && bead.id.includes("-mol-"))
}
