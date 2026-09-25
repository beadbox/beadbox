import { expect, mock, test } from "bun:test"
import { act, renderHook } from "@testing-library/react"
import { useRef, useState } from "react"
import { useBeadActions } from "../hooks/use-bead-actions"
import type { Bead, Epic } from "../lib/types"

test("a saved title patches the tree without starting a duplicate full reload", () => {
  const task = { id: "task-a", type: "task", title: "Old title", parentId: "epic-a", children: [] } as unknown as Bead
  const initial = [{ id: "epic-a", type: "epic", title: "Epic", children: [task] }] as Epic[]
  const loadEpics = mock(async () => {})

  const { result } = renderHook(() => {
    const [epics, setEpics] = useState(initial)
    const [selectedBead, setSelectedBead] = useState<Bead | null>(task)
    const treeContainerRef = useRef<HTMLDivElement>(null)
    const actions = useBeadActions({
      epics,
      setEpics,
      currentWorkspace: null,
      selectedBead,
      setSelectedBead,
      loadEpics,
      handleCloseDetail: () => {},
      treeContainerRef,
      backlogEpics: [],
      archivedEpics: [],
      archivedBeads: [],
    })
    return { epics, actions }
  })

  act(() => result.current.actions.handleBeadUpdate({ ...task, title: "New title" }))
  expect(result.current.epics[0].children[0].title).toBe("New title")
  expect(loadEpics).not.toHaveBeenCalled()

  act(() => result.current.actions.handleBeadUpdate({ ...task, type: "epic" }))
  expect(loadEpics).toHaveBeenCalledTimes(1)
})
