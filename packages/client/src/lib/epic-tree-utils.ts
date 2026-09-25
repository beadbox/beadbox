import type { Bead, Epic, Filters } from "./types"

// bb-pyv8: toastError moved to ./notifications.ts (pure-helper hygiene per
// bb-78qr arch audit). This file no longer imports posthog-js or sonner.

// Category -> human-readable title for error display
export const ERROR_CATEGORY_TITLES: Record<string, string> = {
  "out-of-sync": "Workspace out of sync",
  "database-not-found": "Workspace database not found",
  "permission-denied": "Permission denied",
  "schema-missing": "Workspace not initialized",
  "server-unreachable": "Dolt server unreachable",
  timeout: "Connection timed out",
  unknown: "Unable to load workspace",
}

// Count all beads (issues + epics) in the epic tree recursively
export function countAllBeads(epics: Epic[]): number {
  let count = 0
  function countBead(bead: Bead) {
    count++
    bead.children?.forEach(countBead)
  }
  function countEpic(epic: Epic) {
    count++
    epic.children?.forEach(countBead)
    epic.childEpics?.forEach(countEpic)
  }
  epics.forEach(countEpic)
  return count
}

// Collect all beads (including epics themselves) from the epic tree
export function collectAllBeadsFromEpics(epics: Epic[]): Bead[] {
  const result: Bead[] = []
  function collectBead(bead: Bead) {
    result.push(bead)
    bead.children?.forEach(collectBead)
  }
  function collectEpic(epic: Epic) {
    result.push(epic)
    epic.children?.forEach(collectBead)
    epic.childEpics?.forEach(collectEpic)
  }
  epics.forEach(collectEpic)
  return result
}

// Extract all unique rig names from epics recursively
export function extractRigNames(epics: Epic[]): string[] {
  const rigs = new Set<string>()

  function traverseBead(bead: Bead) {
    if (bead.rigName) {
      rigs.add(bead.rigName)
    }
    bead.children?.forEach(traverseBead)
  }

  function traverseEpic(epic: Epic) {
    traverseBead(epic)
    epic.children?.forEach(traverseBead)
    epic.childEpics?.forEach(traverseEpic)
  }

  epics.forEach(traverseEpic)
  return Array.from(rigs).sort()
}

// Extract all unique assignees from epics recursively
export function extractAssignees(epics: Epic[]): string[] {
  const assignees = new Set<string>()

  function traverseBead(bead: Bead) {
    if (bead.assignee) {
      assignees.add(bead.assignee)
    }
    // Traverse subtasks
    bead.children?.forEach(traverseBead)
  }

  function traverseEpic(epic: Epic) {
    traverseBead(epic)
    epic.children?.forEach(traverseBead)
    epic.childEpics?.forEach(traverseEpic)
  }

  epics.forEach(traverseEpic)
  return Array.from(assignees).sort()
}

// bb-fe03.7: matchesBead was 8 sequential `if (filter not satisfied) return false`
// blocks plus a search subcheck → CCN 18. Collapsed to a predicate-list pattern:
// each predicate returns true when the bead PASSES that filter. The driver loops
// once and short-circuits on the first failure. Adding a new filter = one entry
// in BEAD_FILTER_PREDICATES (no new branch in the driver).
type BeadFilterPredicate = (bead: Bead, filters: Filters) => boolean

function matchesSearch(bead: Bead, filters: Filters): boolean {
  if (!filters.search) return true
  const searchLower = filters.search.toLowerCase()
  return (
    bead.title.toLowerCase().includes(searchLower) ||
    bead.id.toLowerCase().includes(searchLower)
  )
}

const BEAD_FILTER_PREDICATES: BeadFilterPredicate[] = [
  // Hide messages unless explicitly shown
  (b, f) => f.showMessages || f.type === "message" || f.includeSystem || b.type !== "message",
  // beadbox-brg: multi-select status. Strict whitelist — bead matches if
  // its status is in the array. Empty array → nothing visible (Gmail/Linear
  // convention). The FilterBar populates a sensible default on first paint
  // so empty only happens via explicit "deselect all".
  (b, f) => f.status.includes(b.status),
  (b, f) => f.priority === "all" || b.priority === f.priority,
  (b, f) => !f.type || f.type === "all" || b.type === f.type,
  (b, f) => f.assignee === "all" || b.assignee === f.assignee,
  (b, f) => !f.hasSpec || Boolean(b.specId),
  (b, f) => !f.hasDeadline || Boolean(b.dueAt),
  (b, f) => f.rig === "all" || b.rigName === f.rig,
  matchesSearch,
]

// Filter beads based on criteria
export function matchesBead(bead: Bead, filters: Filters): boolean {
  return BEAD_FILTER_PREDICATES.every((predicate) => predicate(bead, filters))
}

// Recursively filter a bead and its children
export function filterBead(bead: Bead, filters: Filters): Bead | null {
  // Recursively filter children first
  const filteredChildren = bead.children
    ?.map((child) => filterBead(child, filters))
    .filter((b): b is Bead => b !== null)

  // Check if bead itself matches
  const beadMatches = matchesBead(bead, filters)

  // Keep bead if it matches or has matching children
  if (beadMatches || (filteredChildren && filteredChildren.length > 0)) {
    return {
      ...bead,
      children: filteredChildren,
    }
  }

  return null
}

// Recursively filter epics - keep epic if it or any descendant matches
export function filterEpic(epic: Epic, filters: Filters): Epic | null {
  // Filter child beads (including their subtasks)
  const filteredChildren = (epic.children ?? [])
    .map((child) => filterBead(child, filters))
    .filter((b): b is Bead => b !== null)

  // Recursively filter child epics
  const filteredChildEpics =
    epic.childEpics
      ?.map((childEpic) => filterEpic(childEpic, filters))
      .filter((e): e is Epic => e !== null) ?? []

  // The _standalone pseudo-epic should only show if it has matching children
  // (it's not a real epic, just a container for orphan beads)
  if (epic.id === "_standalone") {
    if (filteredChildren.length === 0) {
      return null
    }
    return { ...epic, children: filteredChildren, childEpics: [] }
  }

  // Check if epic itself matches
  const epicMatches = matchesBead(epic, filters)

  // Keep epic if it matches, or has matching descendants
  if (epicMatches || filteredChildren.length > 0 || filteredChildEpics.length > 0) {
    return {
      ...epic,
      children: filteredChildren,
      childEpics: filteredChildEpics,
    }
  }

  return null
}

export function filterEpics(epics: Epic[], filters: Filters, rigNames: string[] = []): Epic[] {
  // If rig filter is set but no rigs exist in this workspace, ignore it
  const effectiveFilters =
    filters.rig !== "all" && rigNames.length === 0 ? { ...filters, rig: "all" as const } : filters

  // beadbox-brg: the pre-multi-select code had a fast-path early-return when
  // every filter was at its "all" sentinel. With status as a whitelist there
  // is no such sentinel (every bead requires running the predicate to know
  // it's still in the visible set), so we always run the predicate sweep.
  // Cost is one Array#includes lookup per bead per render — trivial vs the
  // tree walk this function already does for hierarchy preservation.

  return epics
    .map((epic) => filterEpic(epic, effectiveFilters))
    .filter((e): e is Epic => e !== null)
}

// Sort logic extracted to lib/sort.ts (compareBead, sortBeads, sortEpics, statusOrder, priorityOrder)

// Build parent path for a bead
export function findParentPath(
  epics: Epic[],
  beadId: string,
  path: { id: string; title: string }[] = [],
): { id: string; title: string }[] | null {
  function findInChildren(
    parent: Bead,
    parentPath: { id: string; title: string }[],
  ): { id: string; title: string }[] | null {
    for (const child of parent.children ?? []) {
      if (child.id === beadId) return parentPath
      const result = findInChildren(child, [...parentPath, { id: child.id, title: child.title }])
      if (result) return result
    }
    if ("childEpics" in parent && Array.isArray(parent.childEpics)) {
      for (const childEpic of parent.childEpics) {
        if (childEpic.id === beadId) return parentPath
        const result = findInChildren(childEpic, [...parentPath, { id: childEpic.id, title: childEpic.title }])
        if (result) return result
      }
    }
    return null
  }
  for (const epic of epics) {
    const currentPath = [...path, { id: epic.id, title: epic.title }]
    const result = findInChildren(epic, currentPath)
    if (result) return result
  }
  return null
}

// Recursively find a bead by ID in a bead and its children
function findInBead(bead: Bead, beadId: string): Bead | null {
  if (bead.id === beadId) return bead
  if (bead.children) {
    for (const child of bead.children) {
      const found = findInBead(child, beadId)
      if (found) return found
    }
  }
  return null
}

// Find a bead by ID in the epic tree
export function findBeadById(epics: Epic[], beadId: string): Bead | null {
  for (const epic of epics) {
    if (epic.id === beadId) return epic
    for (const child of epic.children ?? []) {
      const found = findInBead(child, beadId)
      if (found) return found
    }
    if (epic.childEpics) {
      const found = findBeadById(epic.childEpics, beadId)
      if (found) return found
    }
  }
  return null
}

// Check if childId is a descendant of the epic with parentId (to prevent circular references)
export function isDescendantOf(parentId: string, childId: string, epics: Epic[]): boolean {
  function checkEpic(epic: Epic): boolean {
    if (epic.id === childId) return true
    return epic.childEpics?.some(checkEpic) ?? false
  }
  function findAndCheck(epicList: Epic[]): boolean {
    for (const epic of epicList) {
      if (epic.id === parentId) return checkEpic(epic)
      if (epic.childEpics && findAndCheck(epic.childEpics)) return true
    }
    return false
  }
  return findAndCheck(epics)
}

// Collect all non-closed children of an epic (including nested epic children)
export function getOpenChildren(epic: Epic): Bead[] {
  const result: Bead[] = []

  function collectFromBead(bead: Bead) {
    if (bead.status !== "closed") {
      result.push(bead)
    }
    bead.children?.forEach(collectFromBead)
  }

  epic.children?.forEach(collectFromBead)
  epic.childEpics?.forEach((childEpic) => {
    if (childEpic.status !== "closed") {
      result.push(childEpic)
    }
    result.push(...getOpenChildren(childEpic))
  })

  return result
}

// beadbox-brg: flatten an epic-tree view to a single list of bead leaves
// (including epics themselves as bead-shaped rows, since epics ARE beads
// with type=epic and they have their own status). Used for the "Grouped"
// layout in workspaces with real epics — we ignore the epic-parent
// hierarchy and just bucket every visible bead by its own status.
export function flattenEpicsToBeads(epics: Epic[]): Bead[] {
  const out: Bead[] = []
  function pushBead(b: Bead) {
    out.push(b)
    b.children?.forEach(pushBead)
  }
  function pushEpic(e: Epic) {
    if (e.id !== "_standalone") out.push(e)
    e.children?.forEach(pushBead)
    e.childEpics?.forEach(pushEpic)
  }
  epics.forEach(pushEpic)
  return out
}

// beadbox-brg: group beads by status for the "Grouped" flat-list display
// mode. Section order is the canonical workflow ramp: open → in_progress →
// (workspace custom chain entries) → closed. Statuses outside this order
// (e.g. blocked, deferred, agent-defined exotics) get a trailing bucket
// preserving their first-seen order so nothing is lost. Empty sections
// are filtered out (per spec AC).
export interface BeadStatusGroup {
  status: string
  label: string
  beads: Bead[]
}

export function groupBeadsByStatus(beads: Bead[], chain: string[]): BeadStatusGroup[] {
  const buckets = new Map<string, Bead[]>()
  for (const b of beads) {
    const arr = buckets.get(b.status)
    if (arr) arr.push(b)
    else buckets.set(b.status, [b])
  }

  const seen = new Set<string>()
  const ordered: string[] = []
  for (const s of ["open", "in_progress", ...chain, "closed"]) {
    if (!seen.has(s)) {
      seen.add(s)
      ordered.push(s)
    }
  }
  // Pick up any statuses we have beads for but haven't placed yet.
  for (const s of buckets.keys()) {
    if (!seen.has(s)) {
      seen.add(s)
      ordered.push(s)
    }
  }

  const labelFor = (s: string): string =>
    s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

  return ordered
    .map((status) => ({ status, label: labelFor(status), beads: buckets.get(status) ?? [] }))
    .filter((g) => g.beads.length > 0)
}
