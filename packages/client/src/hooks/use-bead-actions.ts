import { useCallback, useState, useTransition } from "react"
import { toast } from "sonner"
import { trackedAction } from "@/lib/capture-action-failed"
import { findBeadById, getOpenChildren, isDescendantOf } from "@/lib/epic-tree-utils"
import { getAnalyticsEnabled } from "@/lib/local-storage"
import { toastError } from "@/lib/notifications"
import { safeCapture } from "@/lib/posthog-safe"
import { rpc } from "@/lib/rpc"
import type { Bead, BeadPriority, BeadStatus, Comment, Epic, Workspace } from "@/lib/types"

// kkrpc bindings — same names as the legacy actions/beads.ts exports so the
// home-page port can call them with zero edit-site changes.
const updateBeadPriority = rpc.beads.updateBeadPriority
const updateBeadParent = rpc.beads.updateBeadParent
const updateBeadType = rpc.beads.updateBeadType
const addCommentAction = rpc.beads.addComment
const deleteBead = rpc.beads.deleteBead
const archiveBead = rpc.beads.archiveBead
const closeBeadChildren = rpc.beads.closeBeadChildren
const archiveBeadChildren = rpc.beads.archiveBeadChildren
const closeBead = rpc.beads.closeBead

interface EpicCloseConfirm {
  epicId: string
  epicTitle: string
  action: "close" | "archive"
  openChildren: Bead[]
}

interface UseBeadActionsOpts {
  epics: Epic[]
  setEpics: React.Dispatch<React.SetStateAction<Epic[]>>
  currentWorkspace: Workspace | null
  selectedBead: Bead | null
  setSelectedBead: React.Dispatch<React.SetStateAction<Bead | null>>
  loadEpics: () => Promise<void>
  handleCloseDetail: () => void
  treeContainerRef: React.RefObject<HTMLDivElement | null>
  backlogEpics: Epic[]
  archivedEpics: Epic[]
  archivedBeads: Bead[]
}

export function useBeadActions(opts: UseBeadActionsOpts) {
  const {
    epics,
    setEpics,
    currentWorkspace,
    selectedBead,
    loadEpics,
    handleCloseDetail,
    treeContainerRef,
    backlogEpics,
    archivedEpics,
    archivedBeads,
  } = opts

  const [isPending, startTransition] = useTransition()
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [epicCloseConfirm, setEpicCloseConfirm] = useState<EpicCloseConfirm | null>(null)

  const updateBeadInEpics = useCallback(
    (beadId: string, updateFn: (bead: Bead) => Bead) => {
      // Recursively update a bead and its children
      const updateBead = (bead: Bead): Bead => {
        if (bead.id === beadId) {
          return updateFn(bead)
        }
        if (bead.children) {
          return {
            ...bead,
            children: bead.children.map(updateBead),
          }
        }
        return bead
      }

      const updateEpic = (epic: Epic): Epic => {
        if (epic.id === beadId) {
          // Preserve children/childEpics from the existing epic.
          // The updateFn may return a plain Bead (e.g. from the detail panel)
          // which lacks these properties, causing children to flash-disappear.
          const updated = updateFn(epic)
          return {
            ...updated,
            children: (updated as Epic).children ?? epic.children,
            childEpics: (updated as Epic).childEpics ?? epic.childEpics,
          } as Epic
        }
        return {
          ...epic,
          children: (epic.children ?? []).map(updateBead),
          childEpics: epic.childEpics?.map(updateEpic),
        }
      }

      setEpics((prevEpics) => prevEpics.map(updateEpic))
    },
    [setEpics],
  )

  const removeBeadFromEpics = useCallback(
    (beadId: string) => {
      const filterChildren = (children: Bead[]): Bead[] =>
        children
          .filter((b) => b.id !== beadId)
          .map((b) => (b.children ? { ...b, children: filterChildren(b.children) } : b))

      const filterEpicFn = (epic: Epic): Epic => ({
        ...epic,
        children: filterChildren(epic.children ?? []),
        childEpics: epic.childEpics?.map(filterEpicFn),
      })

      setEpics((prevEpics) => prevEpics.filter((e) => e.id !== beadId).map(filterEpicFn))
    },
    [setEpics],
  )

  const handlePriorityChange = (beadId: string, priority: BeadPriority) => {
    // Look up current priority before optimistic update
    const allSources = [...epics, ...backlogEpics, ...archivedEpics]
    const targetBead = findBeadById(allSources, beadId)
    const fromPriority = targetBead?.priority

    if (getAnalyticsEnabled() && fromPriority !== undefined && fromPriority !== priority) {
      safeCapture("app_issue_priority_changed", {
        from_priority: fromPriority,
        to_priority: priority,
        issue_type: targetBead?.type || "unknown",
      })
    }

    // Optimistic update for instant feedback
    updateBeadInEpics(beadId, (bead) => ({ ...bead, priority }))
    // Server update
    startTransition(async () => {
      const result = await trackedAction("updateBeadPriority", () =>
        updateBeadPriority(beadId, priority, currentWorkspace?.id),
      )
      if (!result.success) {
        console.error("Failed to update priority:", result.error)
      }
      // Always reload to ensure consistency
      loadEpics()
    })
  }

  const handleBeadUpdate = (updatedBead: Bead) => {
    const previous = findBeadById([...epics, ...backlogEpics, ...archivedEpics], updatedBead.id)
    updateBeadInEpics(updatedBead.id, () => updatedBead)
    // Field edits are already visible in the tree. The change subscription
    // fetches the authoritative tree once after bd commits; fetching here as
    // well doubles the slow remote read for every title edit. A hierarchy
    // change still needs an immediate rebuild to move the item between roots.
    if (previous && (previous.type !== updatedBead.type || previous.parentId !== updatedBead.parentId)) {
      void loadEpics()
    }
  }

  const handleAddComment = (beadId: string, comment: Comment) => {
    const issueType = selectedBead?.type ?? "unknown"
    const commentLength = comment.content.length
    // Optimistic update for instant feedback
    updateBeadInEpics(beadId, (bead) => ({
      ...bead,
      comments: [...bead.comments, comment],
    }))
    // Server update
    startTransition(async () => {
      const result = await trackedAction("addComment", () =>
        addCommentAction(beadId, comment.content, currentWorkspace?.id),
      )
      if (!result.success) {
        console.error("Failed to add comment:", result.error)
      }
      if (getAnalyticsEnabled()) {
        safeCapture("app_issue_comment_added", {
          issue_type: issueType,
          comment_length: commentLength,
          success: result.success,
        })
      }
      // Always reload to ensure consistency
      loadEpics()
    })
  }

  const handleDelete = useCallback(
    (beadId: string) => {
      // Delete on server, show toast, then close panel and reload.
      // handleCloseDetail must run after the toast fires; if it runs
      // before startTransition, the URL param change can interrupt the
      // transition and swallow the toast (panel path bug).
      const savedScroll = treeContainerRef.current?.scrollTop ?? 0
      setIsDeleting(true)

      // Look up bead metadata before optimistic removal
      const allEpicSources = [...epics, ...backlogEpics, ...archivedEpics]
      const targetBead = findBeadById(allEpicSources, beadId)

      // Optimistic removal: hide the bead from the tree immediately
      removeBeadFromEpics(beadId)

      // Capture after lookup but before async delete (optimistic tracking)
      if (getAnalyticsEnabled() && targetBead) {
        safeCapture("app_issue_deleted", {
          issue_type: targetBead.type,
          issue_status: targetBead.status,
          had_children: (targetBead.children?.length ?? 0) > 0,
        })
      }

      startTransition(async () => {
        const result = await trackedAction("deleteBead", () =>
          deleteBead(beadId, currentWorkspace?.id),
        )
        if (result.success) {
          toast.success("Bead deleted")
        } else {
          console.error("Failed to delete bead:", result.error)
          toastError("Failed to delete bead", { description: result.error })
        }
        setIsDeleting(false)
        setDeleteConfirmId(null)
        handleCloseDetail()
        await loadEpics()
        requestAnimationFrame(() => {
          if (treeContainerRef.current) {
            treeContainerRef.current.scrollTop = savedScroll
          }
        })
      })
    },
    [
      handleCloseDetail,
      currentWorkspace?.id,
      loadEpics,
      treeContainerRef,
      removeBeadFromEpics,
      epics,
      backlogEpics,
      archivedEpics,
    ],
  )

  const handleBeadMove = useCallback(
    async (beadId: string, targetEpicId: string, demoteToTask?: boolean) => {
      // "_standalone" means remove parent (set to null)
      // "_toplevel" also means remove parent
      const newParentId =
        targetEpicId === "_standalone" || targetEpicId === "_toplevel" ? null : targetEpicId

      // Helper to find a bead/epic by ID in any tree
      const findBead = (id: string, items: (Bead | Epic)[]): Bead | Epic | null => {
        for (const item of items) {
          if (item.id === id) return item
          if (item.children) {
            const found = findBead(id, item.children)
            if (found) return found
          }
          if ("childEpics" in item && item.childEpics) {
            const found = findBead(id, item.childEpics)
            if (found) return found
          }
        }
        return null
      }

      // Check if the bead is in backlog or archive
      const bead = findBead(beadId, [...epics, ...backlogEpics, ...archivedEpics, ...archivedBeads])
      if (targetEpicId === "_standalone" && bead?.type === "milestone") {
        toast("Milestones stay in Milestones")
        return
      }
      const isInBacklog = bead?.priority === "backlog"
      const isInArchive = bead?.labels?.includes("archived")

      // bb-ijuq (ported from main 977f8fd via bb-qyxr): client-side guard
      // against duplicate-dependency errors. If the user drops onto the
      // bead's existing parent (or onto _toplevel/_standalone when it's
      // already top-level), bd rejects with "dependency already exists".
      // Detect the no-op upstream so the rejection never fires — PostHog
      // flagged 11 events of this class on v0.24.1.
      // Note: bead?.parentId is undefined for top-level beads; coerce to
      // null so the equality matches newParentId's null sentinel for the
      // _toplevel/_standalone targets.
      const currentParentId = bead?.parentId ?? null
      if (
        bead &&
        currentParentId === newParentId &&
        !demoteToTask &&
        !isInBacklog &&
        !isInArchive
      ) {
        toast("Already in this epic")
        return
      }

      if (getAnalyticsEnabled()) {
        safeCapture("app_issue_reparented", {
          issue_type: bead?.type || "unknown",
          from_parent: bead?.parentId || null,
          to_parent: targetEpicId,
          demoted_to_task: demoteToTask || false,
        })
      }

      startTransition(async () => {
        // Update parent
        const result = await trackedAction("updateBeadParent", () =>
          updateBeadParent(beadId, newParentId, currentWorkspace?.id),
        )
        if (!result.success) {
          console.error("Failed to move bead:", result.error)
        }

        // Promote to epic if dropping on "Make top-level epic"
        if (
          targetEpicId === "_toplevel" &&
          bead &&
          !["epic", "milestone", "convoy", "molecule"].includes(bead.type)
        ) {
          await trackedAction("updateBeadType", () =>
            updateBeadType(beadId, "epic", currentWorkspace?.id),
          )
        }

        // Demote epic to task if requested
        if (demoteToTask && bead?.type === "epic") {
          await trackedAction("updateBeadType", () =>
            updateBeadType(beadId, "task", currentWorkspace?.id),
          )
        }

        // If moving from backlog or archive, restore priority / remove labels
        if (isInBacklog) {
          await trackedAction("updateBeadPriority", () =>
            updateBeadPriority(beadId, "medium", currentWorkspace?.id),
          )
        }
        if (isInArchive) {
          await trackedAction("archiveBead", () =>
            archiveBead(beadId, false, currentWorkspace?.id),
          )
        }

        // Reload to show the moved bead in its new location
        loadEpics()
      })
    },
    [currentWorkspace?.id, loadEpics, epics, backlogEpics, archivedEpics, archivedBeads],
  )

  // Validate if an epic can be moved to a target (prevents circular references)
  const canMoveEpic = useCallback(
    (epicId: string, targetEpicId: string): boolean => {
      if (epicId === targetEpicId) return false
      if (targetEpicId === "_standalone") return true
      return !isDescendantOf(epicId, targetEpicId, epics)
    },
    [epics],
  )

  // Archive/unarchive handler
  const handleArchive = useCallback(
    async (id: string, archived: boolean) => {
      // Check if archiving an epic with open children
      if (archived) {
        const epic = findBeadById(epics, id)
        if (epic && "childEpics" in epic && epic.id !== "_standalone") {
          const openChildren = getOpenChildren(epic as Epic)
          if (openChildren.length > 0) {
            setEpicCloseConfirm({
              epicId: id,
              epicTitle: epic.title,
              action: "archive",
              openChildren,
            })
            return
          }
        }
      }

      // No optimistic update: keep the row visible with a spinner until bd confirms.
      // Optimistic removal caused flicker when WS refreshes fired mid-operation.
      const result = await trackedAction("archiveBead", () =>
        archiveBead(id, archived, currentWorkspace?.id),
      )
      if (!result.success) {
        console.error("Failed to archive bead:", result.error)
        toastError(archived ? "Failed to archive" : "Failed to unarchive", {
          description: result.error,
        })
      }
      await loadEpics()
    },
    [currentWorkspace?.id, loadEpics, epics],
  )

  // Archive handler for BeadTable rows (always archives, returns Promise for spinner)
  const handleArchiveBead = useCallback(
    async (beadId: string) => {
      await handleArchive(beadId, true)
    },
    [handleArchive],
  )

  // Backlog handler: set priority to backlog (P4) or restore to medium (P2)
  const handleBacklog = useCallback(
    async (id: string, inBacklog: boolean) => {
      startTransition(async () => {
        const priority = inBacklog ? ("backlog" as const) : ("medium" as const)
        const result = await trackedAction("updateBeadPriority", () =>
          updateBeadPriority(id, priority, currentWorkspace?.id),
        )
        if (!result.success) {
          console.error("Failed to update backlog status:", result.error)
          toastError(inBacklog ? "Failed to move to backlog" : "Failed to remove from backlog", {
            description: result.error,
          })
        }
        loadEpics()
      })
    },
    [currentWorkspace?.id, loadEpics],
  )

  // Epic close confirmation: close/archive children too
  const handleEpicCloseWithChildren = useCallback(() => {
    if (!epicCloseConfirm) return
    const { epicId, action, openChildren } = epicCloseConfirm
    const childIds = openChildren.map((c) => c.id)

    startTransition(async () => {
      if (action === "close") {
        await trackedAction("closeBeadChildren", () =>
          closeBeadChildren(childIds, currentWorkspace?.id),
        )
        const result = await trackedAction("closeBead", () =>
          closeBead(epicId, currentWorkspace?.id),
        )
        if (!result.success) {
          toastError("Failed to close epic", { description: result.error })
        }
      } else {
        await trackedAction("archiveBeadChildren", () =>
          archiveBeadChildren(childIds, currentWorkspace?.id),
        )
        const result = await trackedAction("archiveBead", () =>
          archiveBead(epicId, true, currentWorkspace?.id),
        )
        if (!result.success) {
          toastError("Failed to archive epic", { description: result.error })
        }
      }
      loadEpics()
    })
    setEpicCloseConfirm(null)
  }, [epicCloseConfirm, currentWorkspace?.id, loadEpics])

  // Epic close confirmation: proceed without handling children
  const handleEpicCloseOnly = useCallback(() => {
    if (!epicCloseConfirm) return
    const { epicId, action } = epicCloseConfirm

    startTransition(async () => {
      if (action === "close") {
        updateBeadInEpics(epicId, (bead) => ({ ...bead, status: "closed" as BeadStatus }))
        const result = await trackedAction("closeBead", () =>
          closeBead(epicId, currentWorkspace?.id),
        )
        if (!result.success) {
          toastError("Failed to close epic", { description: result.error })
        }
      } else {
        const result = await trackedAction("archiveBead", () =>
          archiveBead(epicId, true, currentWorkspace?.id),
        )
        if (!result.success) {
          toastError("Failed to archive epic", { description: result.error })
        }
      }
      loadEpics()
    })
    setEpicCloseConfirm(null)
  }, [epicCloseConfirm, currentWorkspace?.id, loadEpics, updateBeadInEpics])

  return {
    isPending,
    deleteConfirmId,
    setDeleteConfirmId,
    isDeleting,
    epicCloseConfirm,
    setEpicCloseConfirm,
    updateBeadInEpics,
    handlePriorityChange,
    handleBeadUpdate,
    handleAddComment,
    handleDelete,
    handleBeadMove,
    canMoveEpic,
    handleArchive,
    handleArchiveBead,
    handleBacklog,
    handleEpicCloseWithChildren,
    handleEpicCloseOnly,
  }
}
