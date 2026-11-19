// beadbox-d6l: archiving removes the row at once. A bead whose archive is in
// flight is "pending": every view hides it, even when a refresh brings back the
// tree with the bead still unarchived (bd has not written yet). The archive
// then either succeeds (the reload shows it archived; the id leaves the set)
// or fails (the id leaves the set and the row is back where it was, since bd's
// data never changed).

import { useCallback, useMemo, useRef, useState } from "react"
import type { Bead, Epic } from "./types"

const EMPTY: ReadonlySet<string> = new Set()

function beadWithout(bead: Bead, ids: ReadonlySet<string>): Bead {
  if (!bead.children?.length) return bead
  return { ...bead, children: bead.children.filter((c) => !ids.has(c.id)).map((c) => beadWithout(c, ids)) }
}

function epicWithout(epic: Epic, ids: ReadonlySet<string>): Epic {
  return {
    ...epic,
    children: (epic.children ?? []).filter((c) => !ids.has(c.id)).map((c) => beadWithout(c, ids)),
    childEpics: epic.childEpics?.filter((e) => !ids.has(e.id)).map((e) => epicWithout(e, ids)),
  }
}

/** The tree without any bead or epic whose id is pending; the same array when nothing is. */
export function withoutPending(epics: Epic[], ids: ReadonlySet<string>): Epic[] {
  if (ids.size === 0) return epics
  return epics.filter((e) => !ids.has(e.id)).map((e) => epicWithout(e, ids))
}

export interface PendingArchives {
  ids: ReadonlySet<string>
  /** Mark an id pending. False when it already is (a second click: no second archive). */
  add: (id: string) => boolean
  remove: (id: string) => void
}

export function usePendingArchives(): PendingArchives {
  const [ids, setIds] = useState<ReadonlySet<string>>(EMPTY)
  // The ref answers "already pending?" synchronously, before React re-renders,
  // so two clicks in the same tick still make one archive call.
  const ref = useRef<ReadonlySet<string>>(EMPTY)
  const add = useCallback((id: string) => {
    if (ref.current.has(id)) return false
    const next = new Set(ref.current)
    next.add(id)
    ref.current = next
    setIds(next)
    return true
  }, [])
  const remove = useCallback((id: string) => {
    if (!ref.current.has(id)) return
    const next = new Set(ref.current)
    next.delete(id)
    ref.current = next.size ? next : EMPTY
    setIds(ref.current)
  }, [])
  return useMemo(() => ({ ids, add, remove }), [ids, add, remove])
}
