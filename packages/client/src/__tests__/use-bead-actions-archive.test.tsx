// beadbox-d6l: "Archive bead" removes the row at once; a failed archive puts it
// back where it was with an error naming the bead; a refresh while the archive
// is in flight never brings the row back; a double click archives once.
//
// The harness mirrors home-page: a pending-archive set filters the epics that
// every view renders, and useBeadActions drives it. rpc.beads.archiveBead is a
// promise the test holds and settles.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { act, renderHook } from "@testing-library/react"
import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { useBeadActions } from "../hooks/use-bead-actions"
import { usePendingArchives, withoutPending } from "../lib/pending-archive"
import { _setRpc, type RemoteApi } from "../lib/rpc"
import type { Bead, Epic } from "../lib/types"

type Result = { success: boolean; error?: string }
let calls: string[] = []
let settle: ((r: Result) => void) | null = null
// What bd holds: ids whose archive succeeded. A reload (loadEpics) returns the
// tree with those beads labelled archived, as the sidecar does after a write.
let archivedInBd = new Set<string>()

beforeEach(() => {
  calls = []
  settle = null
  archivedInBd = new Set()
  _setRpc({
    beads: {
      archiveBead: (id: string) => {
        calls.push(id)
        return new Promise<Result>((resolve) => {
          settle = (r) => {
            if (r.success) archivedInBd.add(id)
            resolve(r)
          }
        })
      },
    },
  } as unknown as RemoteApi)
})
afterEach(() => {
  settle = null
})

const task = (id: string, parentId: string, extra: Partial<Bead> = {}): Bead =>
  ({ id, title: id, type: "task", status: "open", priority: "medium", parentId, children: [], ...extra }) as unknown as Bead
const epic = (id: string, children: Bead[], extra: Partial<Epic> = {}): Epic =>
  ({ id, title: id, type: "epic", status: "open", priority: "medium", children, childEpics: [], ...extra }) as unknown as Epic

function tree(): Epic[] {
  return [
    epic("ep-a", [task("ep-a.1", "ep-a"), task("ep-a.2", "ep-a", { children: [task("ep-a.2.1", "ep-a.2")] }), task("ep-a.3", "ep-a")]),
    epic("ep-b", [], { status: "closed" }),
    epic("_standalone", [task("loose-1", "_standalone")]),
  ]
}

/** The tree as bd would return it now: archived beads carry the label. */
function fromBd(): Epic[] {
  const mark = <T extends Bead>(b: T): T =>
    ({
      ...b,
      labels: archivedInBd.has(b.id) ? ["archived"] : b.labels,
      children: b.children?.map(mark),
    }) as T
  return tree().map((e) => ({ ...mark(e), childEpics: e.childEpics?.map(mark) }))
}

function harness(initial = tree()) {
  const reload = { current: (_: Epic[]) => {} }
  const loadEpics = mock(async () => {
    reload.current(fromBd())
  })
  const view = renderHook(() => {
    const pending = usePendingArchives()
    const [loaded, setLoaded] = useState(initial)
    reload.current = setLoaded
    const epics = useMemo(() => withoutPending(loaded, pending.ids), [loaded, pending.ids])
    const treeContainerRef = useRef<HTMLDivElement>(null)
    const actions = useBeadActions({
      epics,
      setEpics: setLoaded,
      currentWorkspace: null,
      selectedBead: null,
      setSelectedBead: () => {},
      loadEpics,
      handleCloseDetail: () => {},
      treeContainerRef,
      backlogEpics: [],
      archivedEpics: [],
      archivedBeads: [],
      pendingArchives: pending,
    })
    return { epics, actions, setLoaded }
  })
  return { view, loadEpics }
}

/** Ids the active list shows: archived beads go to the separate Archived group. */
const ids = (epics: Epic[]): string[] => {
  const out: string[] = []
  const walk = (b: Bead) => {
    if (b.labels?.includes("archived")) return
    out.push(b.id)
    b.children?.forEach(walk)
  }
  for (const e of epics) {
    if (e.labels?.includes("archived")) continue
    out.push(e.id)
    e.children?.forEach(walk)
  }
  return out
}

describe("withoutPending", () => {
  test("removes a pending id at any depth and returns the same array when nothing is pending", () => {
    const t = tree()
    expect(withoutPending(t, new Set())).toBe(t)
    expect(ids(withoutPending(t, new Set(["ep-a.2.1"])))).not.toContain("ep-a.2.1")
    expect(ids(withoutPending(t, new Set(["ep-a.2"])))).not.toContain("ep-a.2")
    expect(ids(withoutPending(t, new Set(["loose-1"])))).not.toContain("loose-1")
    expect(ids(withoutPending(t, new Set(["ep-b"])))).not.toContain("ep-b")
    expect(ids(withoutPending(t, new Set(["ep-a.1"]))).filter((i) => i.startsWith("ep-a"))).toEqual([
      "ep-a",
      "ep-a.2",
      "ep-a.2.1",
      "ep-a.3",
    ])
  })
})

describe("archive bead (beadbox-d6l)", () => {
  test("the row is gone before the archive call resolves; success keeps it gone", async () => {
    const { view, loadEpics } = harness()
    let done!: Promise<void>
    act(() => {
      done = view.result.current.actions.handleArchiveBead("ep-a.2")
    })
    expect(calls).toEqual(["ep-a.2"])
    expect(ids(view.result.current.epics)).not.toContain("ep-a.2")
    await act(async () => {
      settle?.({ success: true })
      await done
    })
    expect(loadEpics).toHaveBeenCalled()
    expect(ids(view.result.current.epics)).not.toContain("ep-a.2")
  })

  test("a failed archive puts the row back at the same place and names the bead", async () => {
    const errorToast = spyOn(toast, "error").mockImplementation(() => "")
    try {
      const { view } = harness()
      const before = ids(view.result.current.epics)
      let done!: Promise<void>
      act(() => {
        done = view.result.current.actions.handleArchiveBead("ep-a.2")
      })
      expect(ids(view.result.current.epics)).not.toContain("ep-a.2")
      await act(async () => {
        settle?.({ success: false, error: "bd: label write refused" })
        await done
      })
      expect(ids(view.result.current.epics)).toEqual(before)
      const messages = errorToast.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => m.includes("ep-a.2"))).toBe(true)
    } finally {
      errorToast.mockRestore()
    }
  })

  test("a refresh mid-flight that still shows the bead unarchived does not bring the row back", async () => {
    const { view } = harness()
    let done!: Promise<void>
    act(() => {
      done = view.result.current.actions.handleArchiveBead("ep-a.1")
    })
    // A live change arrives: the tree is reloaded, bd has not written yet.
    act(() => view.result.current.setLoaded(fromBd()))
    expect(ids(view.result.current.epics)).not.toContain("ep-a.1")
    await act(async () => {
      settle?.({ success: true })
      await done
    })
    expect(ids(view.result.current.epics)).not.toContain("ep-a.1")
  })

  test("a refresh mid-flight, then failure: the row comes back", async () => {
    const { view } = harness()
    let done!: Promise<void>
    act(() => {
      done = view.result.current.actions.handleArchiveBead("loose-1")
    })
    act(() => view.result.current.setLoaded(fromBd()))
    expect(ids(view.result.current.epics)).not.toContain("loose-1")
    await act(async () => {
      settle?.({ success: false, error: "boom" })
      await done
    })
    expect(ids(view.result.current.epics)).toContain("loose-1")
  })

  test("a double click archives once and the row stays gone", async () => {
    const { view } = harness()
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = view.result.current.actions.handleArchiveBead("ep-a.3")
      second = view.result.current.actions.handleArchiveBead("ep-a.3")
    })
    expect(calls).toEqual(["ep-a.3"])
    await act(async () => {
      settle?.({ success: true })
      await Promise.all([first, second])
    })
    expect(calls).toEqual(["ep-a.3"])
    expect(ids(view.result.current.epics)).not.toContain("ep-a.3")
  })

  test("an epic row with no open children leaves at once too", async () => {
    const { view } = harness()
    let done!: Promise<void>
    act(() => {
      done = view.result.current.actions.handleArchive("ep-b", true)
    })
    expect(ids(view.result.current.epics)).not.toContain("ep-b")
    await act(async () => {
      settle?.({ success: true })
      await done
    })
    expect(ids(view.result.current.epics)).not.toContain("ep-b")
  })
})
