// beadbox-429 (GH #56): the one parser for bd's `status.custom` value. Each
// comma-separated entry is `name` or `name:category` (bd accepts the category
// form since 1.1.0); a bead's status is always the bare name, so Beadbox
// matches, displays and writes by name. `token` is the entry exactly as
// configured, kept so a Settings save can write untouched entries back as-is.

export interface StatusConfigEntry {
  name: string
  category?: string
  token: string
}

export function parseStatusConfig(raw: string): StatusConfigEntry[] {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes("(not set)")) return []
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const colon = token.indexOf(":")
      if (colon < 0) return { name: token, token }
      return { name: token.slice(0, colon).trim(), category: token.slice(colon + 1).trim(), token }
    })
    .filter((entry) => entry.name.length > 0)
}

/**
 * The tokens to write for a new list of names: an existing entry keeps its
 * configured token (and so its category); a name not in the config is written
 * bare, and bd resolves its category from the name.
 */
export function tokensForNames(names: readonly string[], current: readonly StatusConfigEntry[]): string[] {
  const byName = new Map(current.map((entry) => [entry.name, entry.token]))
  return names.map((name) => byName.get(name) ?? name)
}
