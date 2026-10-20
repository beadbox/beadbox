// beadbox-id1 (GH #59): what the user is told after a bulk status change,
// and which rows stay selected (pm/spec §4.2.2, the archive failure model).
// Pure: home-page turns this into a toast and a selection prune.

export interface BulkResultEntry {
  id: string
  success: boolean
  error?: string
}

export interface BulkStatusSummary {
  ok: boolean
  title: string
  /** One "id: error" line per failed bead. */
  description?: string
  /** The failed ids, kept selected so the user can retry them. */
  keepSelected: string[]
}

export function summarizeBulkStatus(
  results: BulkResultEntry[],
  statusLabel: string,
): BulkStatusSummary {
  const failed = results.filter((r) => !r.success)
  if (failed.length === 0) {
    const noun = results.length === 1 ? "bead" : "beads"
    return {
      ok: true,
      title: `Updated ${results.length} ${noun} to ${statusLabel}`,
      keepSelected: [],
    }
  }
  return {
    ok: false,
    title: `Updated ${results.length - failed.length} of ${results.length}; ${failed.length} failed`,
    description: failed.map((f) => `${f.id}: ${f.error ?? "unknown error"}`).join("\n"),
    keepSelected: failed.map((f) => f.id),
  }
}
