// Molecules handler namespace. Mirrors the single export of actions/molecules.ts.

import { getMoleculeStructure } from "../lib/bd"
import type { MoleculeGraph } from "../lib/types"
import { workspaceTargetOptions } from "./workspace-target-options"

export async function loadMoleculeGraph(
  beadId: string,
  dbPath?: string,
): Promise<{ success: true; graph: MoleculeGraph } | { success: false; error: string }> {
  try {
    const graph = await getMoleculeStructure(beadId, (await workspaceTargetOptions(dbPath)).options)
    return { success: true, graph }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load molecule graph"
    return { success: false, error: message }
  }
}
