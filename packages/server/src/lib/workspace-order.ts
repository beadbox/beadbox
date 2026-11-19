// beadbox-984: the user's order of the Workspaces sidebar.
//
// The order IS the registry's array order (~/.beadbox/registry.json), so there
// is no second list to keep in step: an add pushes to the end, a removal
// filters, and every other registry write keeps its entry's position.

/** Most ids one reorder request may carry; anything longer is refused unread. */
export const MAX_WORKSPACE_ORDER_IDS = 1000

/**
 * Put `entries` in the requested order. The request comes from the client and
 * may be stale (a workspace added or removed on another surface since it
 * rendered), so: requested ids that exist come first, in the requested order;
 * every entry the request does not name follows, in its current relative
 * order; unknown and repeated ids are ignored. Returns a new array of the same
 * entry objects; `entries` is not modified.
 */
export function applyWorkspaceOrder<T extends { id: string }>(
  entries: readonly T[],
  requestedIds: readonly string[],
): T[] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const placed = new Set<string>()
  const ordered: T[] = []
  for (const id of requestedIds) {
    const entry = byId.get(id)
    if (entry === undefined || placed.has(id)) continue
    placed.add(id)
    ordered.push(entry)
  }
  for (const entry of entries) {
    if (!placed.has(entry.id)) ordered.push(entry)
  }
  return ordered
}
