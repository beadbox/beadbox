// Every table whose revision can change a user-visible bead view.
export const POLLED_TABLES = [
  "issues",
  "comments",
  "labels",
  "dependencies",
  "wisps",
  "wisp_comments",
  "wisp_labels",
  "wisp_dependencies",
] as const

const ALIASES = ["ih", "ch", "lh", "dh", "wh", "wch", "wlh", "wdh"] as const

export const SERVER_POLL_SQL = `SELECT ${POLLED_TABLES.map(
  (table, index) => `DOLT_HASHOF_TABLE('${table}') AS ${ALIASES[index]}`,
).join(", ")}`

export function hashSummary(pollResult: string): string | null {
  try {
    const rows = JSON.parse(pollResult)
    if (Array.isArray(rows) && rows.length > 0) {
      const parts: string[] = []
      for (const alias of ALIASES) {
        const value = rows[0][alias]
        if (typeof value === "string") parts.push(value.slice(0, 6))
      }
      return parts.length > 0 ? parts.join(":") : null
    }
  } catch (err) {
    console.warn(
      `[change-detector] hashSummary parse failed: ${err instanceof Error ? err.message : err}`,
    )
  }
  return null
}
