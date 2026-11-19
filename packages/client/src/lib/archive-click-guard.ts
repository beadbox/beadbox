// beadbox-d6l regression: archiving removes the row at once, so on a double-click
// the next row slides under the pointer and the second click archived it too.
// An archive click is ignored when it is the second click of a double-click
// (event.detail > 1), or when it comes within a short window after the last
// accepted archive click (in case an engine resets the click count once the
// element under the pointer changes). Shared by every row's archive button.

export const ARCHIVE_CLICK_GUARD_MS = 500

let lastAcceptedAt = Number.NEGATIVE_INFINITY

/** True when this click should archive; records it. False for a double-click's follow-up. */
export function acceptArchiveClick(event: { detail: number }, now: number = Date.now()): boolean {
  if (event.detail > 1) return false
  if (now - lastAcceptedAt < ARCHIVE_CLICK_GUARD_MS) return false
  lastAcceptedAt = now
  return true
}

/** Tests only: forget the last accepted click. */
export function _resetArchiveClickGuard(): void {
  lastAcceptedAt = Number.NEGATIVE_INFINITY
}
