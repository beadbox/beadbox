// beadbox-005: React keys for one rendered list, stable across live refreshes.
//
// Rows were keyed by their index, so a change that moved one row re-keyed (and
// remounted) every row after it on every refresh. Key by id instead. Create one
// keyer per list per render: the first occurrence of an id keys as the id
// itself, and a repeat within the same list (malformed data) gets `~2`, `~3`,
// so keys stay unique among siblings without falling back to the index.
export function makeKeyer(): (id: string) => string {
  const seen = new Map<string, number>()
  return (id) => {
    const n = (seen.get(id) ?? 0) + 1
    seen.set(id, n)
    return n === 1 ? id : `${id}~${n}`
  }
}
