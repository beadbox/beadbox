// beadbox-g9xr: a write whose rpc call REJECTS is a failed write.
//
// rpc.* calls reject, not return {success:false}, when the sidecar session is
// destroyed mid-call (exit or restart) or the 45 s call deadline fires. Every
// write used to await the call with no catch, so a rejection skipped both the
// success and the failure branch: the optimistic value stayed on screen, the
// saving spinner never cleared, and no toast appeared. trackedAction (and
// settleAction, for the writes that do not go through it) now turn the
// rejection into {success:false, error}, so each caller's own failure branch
// runs. These tests install a throwing rpc with _setRpc and check that branch.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useRef, useState } from "react"
import { toast } from "sonner"

import type { FieldName } from "../components/bead-detail-helpers"
import { CustomStatusesManager } from "../components/custom-statuses-manager"
import { FormulaPourModal } from "../components/formula-pour-modal"
import { WorkspaceErrorScreen } from "../components/workspace-error-screen"
import { useBeadActions } from "../hooks/use-bead-actions"
import { useBeadMutations } from "../hooks/use-bead-mutations"
import type { BdLoadError } from "../lib/bd-error"
// Namespace import: a missing export then fails only the test that uses it.
import * as capture from "../lib/capture-action-failed"
import { _resetRpc, _setRpc, type RemoteApi } from "../lib/rpc"
import type { Bead, Epic, FormulaDetail } from "../lib/types"

const GONE = "sidecar gone"

/** An rpc whose every call in the listed namespaces throws, recording the calls. */
function installThrowingRpc(namespaces: string[]): string[] {
  const calls: string[] = []
  const ns = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method) => async () => {
          calls.push(`${name}.${String(method)}`)
          throw new Error(GONE)
        },
      },
    )
  _setRpc(Object.fromEntries(namespaces.map((n) => [n, ns(n)])) as unknown as RemoteApi)
  return calls
}

let errorToast: ReturnType<typeof spyOn>

beforeEach(() => {
  errorToast = spyOn(toast, "error").mockImplementation(() => "")
})

afterEach(() => {
  cleanup()
  errorToast.mockRestore()
  _resetRpc()
})

describe("trackedAction", () => {
  // Spied on the module's own export, not on posthog: feature-flag.test.ts
  // replaces posthog-js process-wide, so which posthog object posthog-safe
  // holds depends on file order (green on macOS, 0 captures on Linux CI).
  let captured: ReturnType<typeof spyOn>
  beforeEach(() => {
    captured = spyOn(capture, "captureServerActionFailed").mockImplementation(() => {})
  })
  afterEach(() => captured.mockRestore())

  const failures = () => captured.mock.calls as unknown[][]

  test("a rejecting call resolves to {success:false} with the error's message, captured once", async () => {
    const result = await capture.trackedAction("updateBeadStatus", async () => {
      throw new Error("rpc.beads.updateBeadStatus: the Beadbox sidecar did not respond within 45s")
    })
    expect(result).toEqual({
      success: false,
      error: "rpc.beads.updateBeadStatus: the Beadbox sidecar did not respond within 45s",
    })
    expect(failures()).toHaveLength(1)
    expect(failures()[0][0]).toBe("updateBeadStatus")
    expect(failures()[0][1]).toBe(
      "rpc.beads.updateBeadStatus: the Beadbox sidecar did not respond within 45s",
    )
  })

  test("a non-Error rejection is stringified", async () => {
    const result = await capture.trackedAction("x", () => Promise.reject("plain text"))
    expect(result).toEqual({ success: false, error: "plain text" })
  })

  test("returned results are unchanged: failure captured once, success not at all", async () => {
    const failed = { success: false, error: "bd said no" }
    expect(await capture.trackedAction("x", async () => failed)).toBe(failed)
    expect(failures()).toHaveLength(1)
    const ok = { success: true, extra: 1 }
    expect(await capture.trackedAction("y", async () => ok)).toBe(ok)
    expect(failures()).toHaveLength(1)
  })

  test("settleAction converts a rejection the same way and captures nothing", async () => {
    const result = await capture.settleAction(async () => {
      throw new Error(GONE)
    })
    expect(result).toEqual({ success: false, error: GONE })
    expect(failures()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Detail panel writes (use-bead-mutations.ts)
// ---------------------------------------------------------------------------

const bead = {
  id: "t-1",
  title: "Old title",
  type: "task",
  status: "open",
  priority: "medium",
  assignee: "alice",
  labels: ["keep", "drop"],
  specId: "S-1",
  design: "design 0",
  description: "desc 0",
  acceptanceCriteria: "ac 0",
  notes: "notes 0",
  comments: [{ id: "c-1", author: "a", content: "hi", createdAt: new Date() }],
  blockedBy: [{ id: "t-0", title: "blocker", status: "open" }],
  blocks: [],
} as unknown as Bead

type Mutations = ReturnType<typeof useBeadMutations>

interface FieldCase {
  name: string
  field: FieldName
  toast: string
  act: (m: Mutations) => unknown
  value: (m: Mutations) => unknown
  before: unknown
}

const fieldCases: FieldCase[] = [
  {
    name: "title",
    field: "title",
    toast: "Failed to save title",
    act: (m) => m.handleTitleChange("New title"),
    value: (m) => m.title,
    before: "Old title",
  },
  {
    name: "type",
    field: "type",
    toast: "Failed to save type",
    act: (m) => m.handleTypeChange("bug"),
    value: (m) => m.type,
    before: "task",
  },
  {
    name: "status",
    field: "status",
    toast: "Failed to save status",
    act: (m) => m.handleStatusChange("closed"),
    value: (m) => m.status,
    before: "open",
  },
  {
    name: "priority",
    field: "priority",
    toast: "Failed to save priority",
    act: (m) => m.handlePriorityChange("high"),
    value: (m) => m.priority,
    before: "medium",
  },
  {
    name: "assignee",
    field: "assignee",
    toast: "Failed to save assignee",
    act: (m) => m.handleAssigneeChange("bob"),
    value: (m) => m.assignee,
    before: "alice",
  },
  {
    name: "spec id",
    field: "specId",
    toast: "Failed to save spec ID",
    act: (m) => m.saveSpecId("S-2"),
    value: (m) => m.specId,
    before: "S-1",
  },
  {
    name: "due",
    field: "dueAt",
    toast: "Failed to save due date",
    act: (m) => m.saveDue("2026-12-01"),
    value: (m) => m.dueAt,
    before: undefined,
  },
  {
    name: "defer",
    field: "deferUntil",
    toast: "Failed to save defer date",
    act: (m) => m.saveDefer("2026-12-01"),
    value: (m) => m.deferUntil,
    before: undefined,
  },
  {
    name: "estimate",
    field: "estimatedMinutes",
    toast: "Failed to save estimate",
    act: (m) => m.saveEstimate(90),
    value: (m) => m.estimatedMinutes,
    before: undefined,
  },
  {
    name: "design",
    field: "design",
    toast: "Failed to save design",
    act: (m) => m.saveDesign("design 1"),
    value: (m) => m.design,
    before: "design 0",
  },
  {
    name: "description",
    field: "description",
    toast: "Failed to save description",
    act: (m) => m.saveTextField("description", "desc 1"),
    value: (m) => m.description,
    before: "desc 0",
  },
  {
    name: "acceptance criteria",
    field: "acceptanceCriteria",
    toast: "Failed to save acceptanceCriteria",
    act: (m) => m.saveTextField("acceptanceCriteria", "ac 1"),
    value: (m) => m.acceptanceCriteria,
    before: "ac 0",
  },
  {
    name: "notes",
    field: "notes",
    toast: "Failed to save notes",
    act: (m) => m.saveTextField("notes", "notes 1"),
    value: (m) => m.notes,
    before: "notes 0",
  },
]

function renderMutations() {
  const onUpdate = mock((_b: Bead) => {})
  const hook = renderHook(() => useBeadMutations({ bead, dbPath: "/tmp/ws/.beads", onUpdate }))
  return { ...hook, onUpdate }
}

describe("detail panel: a thrown write ends like a failed one", () => {
  test.each(
    fieldCases.map((c) => [c.name, c] as const),
  )("%s: previous value back, saving cleared, one toast naming the field", async (_name, c) => {
    const calls = installThrowingRpc(["beads"])
    const { result, onUpdate } = renderMutations()
    act(() => {
      // Not awaited here: two of the handlers (title, assignee) do not
      // return the write's promise. Wait for the write itself instead.
      void c.act(result.current)
    })
    // The title save is debounced 500 ms.
    await waitFor(() => expect(calls).toHaveLength(1), { timeout: 2_000 })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(c.value(result.current)).toEqual(c.before)
    expect(result.current.fieldStates[c.field].isSaving).toBe(false)
    expect(result.current.fieldStates[c.field].hasError).toBe(true)
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toBe(c.toast)
    expect(errorToast.mock.calls[0][1]).toEqual({ description: GONE })
    expect(onUpdate).not.toHaveBeenCalled()
  })

  test("removing a label: the chip comes back, one toast", async () => {
    installThrowingRpc(["beads"])
    const { result, onUpdate } = renderMutations()
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.handleRemoveLabel("drop")
    })
    expect(result.current.labels).toEqual(["keep"])
    await act(async () => {
      await pending
    })
    expect(result.current.labels).toEqual(["keep", "drop"])
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toBe("Failed to remove label")
    expect(onUpdate).not.toHaveBeenCalled()
  })

  test("removing a dependency: the tree gets the original bead back, one toast", async () => {
    installThrowingRpc(["beads"])
    const { result, onUpdate } = renderMutations()
    await act(async () => {
      await result.current.handleRemoveDependency("t-0", "blockedBy")
    })
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(onUpdate.mock.calls[0][0].blockedBy).toEqual([])
    expect(onUpdate.mock.calls[1][0]).toBe(bead)
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toBe("Failed to remove dependency")
  })

  test("deleting a comment: the comment stays, one toast", async () => {
    installThrowingRpc(["beads"])
    const { result, onUpdate } = renderMutations()
    await act(async () => {
      await result.current.handleDeleteComment("c-1")
    })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toBe("Failed to delete comment")
  })
})

// ---------------------------------------------------------------------------
// Tree writes (use-bead-actions.ts), most inside startTransition(async ...)
// ---------------------------------------------------------------------------

function renderActions() {
  const epicChild = { id: "c-1", type: "task", status: "open", title: "child", children: [] }
  const initial = [
    {
      id: "e-1",
      type: "epic",
      status: "open",
      title: "Epic",
      children: [epicChild],
      childEpics: [],
    },
  ] as unknown as Epic[]
  const loadEpics = mock(async () => {})
  const handleCloseDetail = mock(() => {})
  const hook = renderHook(() => {
    const [epics, setEpics] = useState(initial)
    const [selectedBead, setSelectedBead] = useState<Bead | null>(null)
    const treeContainerRef = useRef<HTMLDivElement>(null)
    const actions = useBeadActions({
      epics,
      setEpics,
      currentWorkspace: null,
      selectedBead,
      setSelectedBead,
      loadEpics,
      handleCloseDetail,
      treeContainerRef,
      backlogEpics: [],
      archivedEpics: [],
      archivedBeads: [],
    })
    return { epics, actions }
  })
  return { ...hook, loadEpics, handleCloseDetail }
}

describe("tree actions: a thrown write toasts and reloads", () => {
  test("backlog: one toast, the tree reloads", async () => {
    installThrowingRpc(["beads"])
    const { result, loadEpics } = renderActions()
    await act(async () => {
      await result.current.actions.handleBacklog("c-1", true)
    })
    await waitFor(() => expect(loadEpics).toHaveBeenCalledTimes(1))
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toBe("Failed to move to backlog")
  })

  test("close epic only (optimistic close): one toast, the tree reloads", async () => {
    installThrowingRpc(["beads"])
    const { result, loadEpics } = renderActions()
    act(() =>
      result.current.actions.setEpicCloseConfirm({
        epicId: "e-1",
        epicTitle: "Epic",
        action: "close",
        openChildren: [],
      }),
    )
    act(() => result.current.actions.handleEpicCloseOnly())
    await waitFor(() => expect(loadEpics).toHaveBeenCalledTimes(1))
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toBe("Failed to close epic")
  })

  test("close epic with children: one toast, the tree reloads", async () => {
    installThrowingRpc(["beads"])
    const { result, loadEpics } = renderActions()
    act(() =>
      result.current.actions.setEpicCloseConfirm({
        epicId: "e-1",
        epicTitle: "Epic",
        action: "close",
        openChildren: [{ id: "c-1" } as unknown as Bead],
      }),
    )
    act(() => result.current.actions.handleEpicCloseWithChildren())
    await waitFor(() => expect(loadEpics).toHaveBeenCalledTimes(1))
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toBe("Failed to close epic")
  })

  test("delete: one toast, panel closed, deleting cleared, the tree reloads", async () => {
    installThrowingRpc(["beads"])
    const { result, loadEpics, handleCloseDetail } = renderActions()
    act(() => result.current.actions.handleDelete("c-1"))
    await waitFor(() => expect(loadEpics).toHaveBeenCalledTimes(1))
    expect(result.current.actions.isDeleting).toBe(false)
    expect(handleCloseDetail).toHaveBeenCalledTimes(1)
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toBe("Failed to delete bead")
  })

  test("archive: one toast, the tree reloads", async () => {
    installThrowingRpc(["beads"])
    const { result, loadEpics } = renderActions()
    await act(async () => {
      await result.current.actions.handleArchive("c-1", true)
    })
    expect(loadEpics).toHaveBeenCalledTimes(1)
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toBe("Failed to archive")
  })
})

// ---------------------------------------------------------------------------
// Writes that call rpc directly (pm's note on the bead)
// ---------------------------------------------------------------------------

describe("direct rpc writes: a thrown call clears the spinner and reports", () => {
  const user = () => userEvent.setup({ delay: null })

  test("pour: spinner cleared, Pour usable again, one toast", async () => {
    installThrowingRpc(["formulas"])
    const formula = {
      formula: "fixed",
      description: "d",
      version: 1,
      type: "workflow",
      source: "/tmp/ws/.beads/formulas/fixed.formula.toml",
      steps: [{ id: "a", title: "A", type: "task" }],
    } as FormulaDetail
    render(
      <FormulaPourModal open onOpenChange={() => {}} formula={formula} dbPath="/tmp/ws/.beads" />,
    )
    const pour = screen.getByRole("button", { name: "Pour" })
    await user().click(pour)
    await waitFor(() => expect(errorToast).toHaveBeenCalledTimes(1))
    expect(errorToast.mock.calls[0]).toEqual(["Pour failed", { description: GONE }])
    expect((screen.getByRole("button", { name: "Pour" }) as HTMLButtonElement).disabled).toBe(false)
  })

  test("custom statuses save: one toast, Save usable again", async () => {
    // The list loads from a working read; only the save throws.
    _setRpc({
      beads: {
        getCustomStatusList: async () => [],
        updateCustomStatuses: async () => {
          throw new Error(GONE)
        },
      },
    } as unknown as RemoteApi)
    const u = user()
    render(<CustomStatusesManager databasePath="/tmp/ws/.beads" />)
    await waitFor(() => expect(screen.getByRole("textbox")).toBeDefined())
    await u.type(screen.getByRole("textbox"), "ready_for_qa")
    await u.click(screen.getByRole("button", { name: /add status/i }))
    await u.click(screen.getByRole("button", { name: /save custom statuses/i }))
    await waitFor(() => expect(errorToast).toHaveBeenCalledTimes(1))
    expect(errorToast.mock.calls[0]).toEqual(["Failed to save", { description: GONE }])
    expect(
      (screen.getByRole("button", { name: /save custom statuses/i }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  test("workspace error screen Fix: spinner cleared, the error shown", async () => {
    installThrowingRpc(["recovery"])
    const error: BdLoadError = {
      category: "out-of-sync",
      severity: "recoverable",
      message: "out of sync",
      stderr: null,
      fixCommand: "bd doctor --fix",
      fixDescription: null,
    }
    const rootRoute = createRootRoute({
      component: () => (
        <WorkspaceErrorScreen
          error={error}
          onRetry={() => {}}
          isRetrying={false}
          databasePath="/tmp/ws/.beads"
        />
      ),
    })
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
    render(<RouterProvider router={router as never} />)
    const u = user()
    await u.click(await screen.findByRole("button", { name: "Fix this" }))
    await u.click(await screen.findByRole("button", { name: "Continue" }))
    await waitFor(() => expect(screen.getByText(GONE)).toBeTruthy())
    expect(screen.getByRole("button", { name: "Fix this" })).toBeTruthy()
    expect(screen.queryByText("Fixing...")).toBeNull()
  })
})
