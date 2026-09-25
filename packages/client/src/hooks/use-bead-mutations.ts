import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { trackedAction } from "@/lib/capture-action-failed"
import { getAnalyticsEnabled, getArchiveHintShown, setArchiveHintShown } from "@/lib/local-storage"
import { safeCapture } from "@/lib/posthog-safe"
import { rpc } from "@/lib/rpc"

const updateBeadTitle = rpc.beads.updateBeadTitle
const updateBeadType = rpc.beads.updateBeadType
const updateBeadStatus = rpc.beads.updateBeadStatus
const updateBeadPriority = rpc.beads.updateBeadPriority
const updateBeadAssignee = rpc.beads.updateBeadAssignee
const updateBeadSpecId = rpc.beads.updateBeadSpecId
const updateBeadDue = rpc.beads.updateBeadDue
const updateBeadDefer = rpc.beads.updateBeadDefer
const updateBeadEstimate = rpc.beads.updateBeadEstimate
const updateBeadDesign = rpc.beads.updateBeadDesign
const updateBeadTextField = rpc.beads.updateBeadTextField
const deleteCommentAction = rpc.beads.deleteCommentAction
const removeLabelAction = rpc.beads.removeLabelAction
const removeDependencyAction = rpc.beads.removeDependencyAction
const addLabelAction = rpc.beads.addLabelAction
const readSpecFile = rpc.beads.readSpecFile
const archiveBead = rpc.beads.archiveBead

import {
  captureDetailPanelAction,
  type FieldName,
  type FieldState,
  initialFieldStates,
} from "@/components/bead-detail-helpers"
import { toastError } from "@/lib/notifications"
import type { Bead, BeadPriority, BeadStatus, BeadType } from "@/lib/types"

interface UseBeadMutationsOptions {
  bead: Bead | null
  dbPath?: string
  onUpdate: (bead: Bead) => void
}

export function useBeadMutations({ bead, dbPath, onUpdate }: UseBeadMutationsOptions) {
  // ---------------------------------------------------------------------------
  // Field values (local state synced from bead prop)
  // ---------------------------------------------------------------------------
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [design, setDesign] = useState("")
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("")
  const [notes, setNotes] = useState("")
  const [type, setType] = useState<BeadType>("task")
  const [status, setStatus] = useState<BeadStatus>("open")
  const [priority, setPriority] = useState<BeadPriority>("medium")
  const [assignee, setAssignee] = useState("")
  const [labels, setLabels] = useState<string[]>([])
  const [specId, setSpecId] = useState("")
  const [dueAt, setDueAt] = useState<Date | undefined>(undefined)
  const [deferUntil, setDeferUntil] = useState<Date | undefined>(undefined)
  const [estimatedMinutes, setEstimatedMinutes] = useState<number | undefined>(undefined)

  // ---------------------------------------------------------------------------
  // Field save/error state
  // ---------------------------------------------------------------------------
  const [fieldStates, setFieldStates] = useState<Record<FieldName, FieldState>>(initialFieldStates)

  const setFieldSaving = useCallback((field: FieldName) => {
    setFieldStates((prev) => ({ ...prev, [field]: { isSaving: true, hasError: false } }))
  }, [])

  const setFieldSuccess = useCallback((field: FieldName) => {
    setFieldStates((prev) => ({ ...prev, [field]: { isSaving: false, hasError: false } }))
  }, [])

  const setFieldError = useCallback((field: FieldName) => {
    setFieldStates((prev) => ({ ...prev, [field]: { isSaving: false, hasError: true } }))
  }, [])

  const clearFieldError = useCallback((field: FieldName) => {
    setFieldStates((prev) => ({ ...prev, [field]: { ...prev[field], hasError: false } }))
  }, [])

  // ---------------------------------------------------------------------------
  // Sync from bead prop
  // ---------------------------------------------------------------------------
  const beadSyncKey =
    bead &&
    JSON.stringify([
      bead.id,
      bead.title,
      bead.description,
      bead.design,
      bead.acceptanceCriteria,
      bead.notes,
      bead.type,
      bead.status,
      bead.priority,
      bead.assignee,
      bead.specId,
      bead.dueAt,
      bead.deferUntil,
      bead.estimatedMinutes,
      bead.updatedAt,
      bead.labels,
    ])
  const lastSyncedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!bead || !beadSyncKey) {
      lastSyncedKeyRef.current = null
      return
    }
    if (lastSyncedKeyRef.current === beadSyncKey) return
    lastSyncedKeyRef.current = beadSyncKey
    setTitle(bead.title)
    setDescription(bead.description)
    setDesign(bead.design || "")
    setAcceptanceCriteria(bead.acceptanceCriteria || "")
    setNotes(bead.notes || "")
    setType(bead.type)
    setStatus(bead.status)
    setPriority(bead.priority)
    setAssignee(bead.assignee)
    setSpecId(bead.specId || "")
    setDueAt(bead.dueAt)
    setDeferUntil(bead.deferUntil)
    setEstimatedMinutes(bead.estimatedMinutes)
    setLabels(bead.labels || [])
  }, [bead, beadSyncKey])

  // Reset field states on bead change
  const beadId = bead?.id
  useEffect(() => {
    if (beadId) {
      setFieldStates(initialFieldStates)
    }
  }, [beadId])

  // ---------------------------------------------------------------------------
  // Debounced title save
  // ---------------------------------------------------------------------------
  const titleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current)
    }
  }, [])

  const saveTitle = useCallback(
    async (newTitle: string) => {
      if (!bead || newTitle === bead.title) return
      setFieldSaving("title")
      const result = await trackedAction("updateBeadTitle", () =>
        updateBeadTitle(bead.id, newTitle, dbPath),
      )
      if (result.success) {
        setFieldSuccess("title")
        onUpdate({ ...bead, title: newTitle, updatedAt: new Date() })
        captureDetailPanelAction("edit_field", bead.type)
      } else {
        setFieldError("title")
        setTitle(bead.title)
        toastError("Failed to save title", { description: result.error })
        setTimeout(() => clearFieldError("title"), 2000)
      }
    },
    [bead, dbPath, onUpdate, setFieldSaving, setFieldSuccess, setFieldError, clearFieldError],
  )

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      setTitle(newTitle)
      if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current)
      titleTimeoutRef.current = setTimeout(() => saveTitle(newTitle), 500)
    },
    [saveTitle],
  )

  // ---------------------------------------------------------------------------
  // Type (immediate)
  // ---------------------------------------------------------------------------
  const handleTypeChange = useCallback(
    async (newType: BeadType) => {
      if (!bead || newType === type) return
      const prevType = type
      setFieldSaving("type")
      setType(newType)
      const result = await trackedAction("updateBeadType", () =>
        updateBeadType(bead.id, newType, dbPath),
      )
      if (result.success) {
        setFieldSuccess("type")
        onUpdate({ ...bead, type: newType, updatedAt: new Date() })
        captureDetailPanelAction("edit_field", newType)
      } else {
        setFieldError("type")
        setType(prevType)
        toastError("Failed to save type", { description: result.error })
        setTimeout(() => clearFieldError("type"), 2000)
      }
    },
    [bead, type, dbPath, onUpdate, setFieldSaving, setFieldSuccess, setFieldError, clearFieldError],
  )

  // ---------------------------------------------------------------------------
  // Status (immediate)
  // ---------------------------------------------------------------------------
  const handleStatusChange = useCallback(
    async (newStatus: BeadStatus) => {
      if (!bead || newStatus === status) return
      const prevStatus = status
      setFieldSaving("status")
      setStatus(newStatus)
      const result = await trackedAction("updateBeadStatus", () =>
        updateBeadStatus(bead.id, newStatus, dbPath),
      )
      if (getAnalyticsEnabled()) {
        safeCapture("app_issue_status_changed", {
          from_status: prevStatus,
          to_status: newStatus,
          issue_type: bead.type,
          source: "panel",
          success: result.success,
          error_message: result.success ? null : (result.error ?? null),
        })
        if (result.success) {
          captureDetailPanelAction("status_change", bead.type)
        }
      }
      if (result.success) {
        setFieldSuccess("status")
        onUpdate({ ...bead, status: newStatus, updatedAt: new Date() })
        if (newStatus === "closed" && !getArchiveHintShown()) {
          const alreadyArchived = bead.labels?.includes("archived")
          if (!alreadyArchived) {
            toast("Bead closed!", {
              description: "Drag closed beads to the Archive zone to declutter your board.",
              duration: 10000,
              action: {
                label: "Archive now",
                onClick: () => {
                  setArchiveHintShown()
                  trackedAction("archiveBead", () => archiveBead(bead.id, true, dbPath)).then(
                    (archiveResult) => {
                      if (archiveResult.success) {
                        toast.success("Archived! Find it in the Archived section below.")
                        onUpdate({
                          ...bead,
                          status: newStatus,
                          labels: [...(bead.labels || []), "archived"],
                          updatedAt: new Date(),
                        })
                      } else {
                        toastError("Failed to archive", { description: archiveResult.error })
                      }
                    },
                  )
                },
              },
              cancel: {
                label: "Got it",
                onClick: () => {
                  setArchiveHintShown()
                },
              },
              onDismiss: () => {
                setArchiveHintShown()
              },
            })
          }
        }
      } else {
        setFieldError("status")
        setStatus(prevStatus)
        toastError("Failed to save status", { description: result.error })
        setTimeout(() => clearFieldError("status"), 2000)
      }
    },
    [
      bead,
      status,
      dbPath,
      onUpdate,
      setFieldSaving,
      setFieldSuccess,
      setFieldError,
      clearFieldError,
    ],
  )

  // ---------------------------------------------------------------------------
  // Priority (immediate)
  // ---------------------------------------------------------------------------
  const handlePriorityChange = useCallback(
    async (newPriority: BeadPriority) => {
      if (!bead || newPriority === priority) return
      const prevPriority = priority
      setFieldSaving("priority")
      setPriority(newPriority)
      const result = await trackedAction("updateBeadPriority", () =>
        updateBeadPriority(bead.id, newPriority, dbPath),
      )
      if (result.success) {
        setFieldSuccess("priority")
        onUpdate({ ...bead, priority: newPriority, updatedAt: new Date() })
        captureDetailPanelAction("edit_field", bead.type)
      } else {
        setFieldError("priority")
        setPriority(prevPriority)
        toastError("Failed to save priority", { description: result.error })
        setTimeout(() => clearFieldError("priority"), 2000)
      }
    },
    [
      bead,
      priority,
      dbPath,
      onUpdate,
      setFieldSaving,
      setFieldSuccess,
      setFieldError,
      clearFieldError,
    ],
  )

  // ---------------------------------------------------------------------------
  // Assignee (immediate)
  // ---------------------------------------------------------------------------
  const saveAssignee = useCallback(
    async (newAssignee: string) => {
      if (!bead || newAssignee === bead.assignee) return
      setFieldSaving("assignee")
      const result = await trackedAction("updateBeadAssignee", () =>
        updateBeadAssignee(bead.id, newAssignee, dbPath),
      )
      if (result.success) {
        setFieldSuccess("assignee")
        onUpdate({ ...bead, assignee: newAssignee, updatedAt: new Date() })
        captureDetailPanelAction("edit_field", bead.type)
      } else {
        setFieldError("assignee")
        setAssignee(bead.assignee)
        toastError("Failed to save assignee", { description: result.error })
        setTimeout(() => clearFieldError("assignee"), 2000)
      }
    },
    [bead, dbPath, onUpdate, setFieldSaving, setFieldSuccess, setFieldError, clearFieldError],
  )

  const handleAssigneeChange = useCallback(
    (newAssignee: string) => {
      setAssignee(newAssignee)
      saveAssignee(newAssignee)
    },
    [saveAssignee],
  )

  // ---------------------------------------------------------------------------
  // Spec ID
  // ---------------------------------------------------------------------------
  const saveSpecId = useCallback(
    async (newSpecId: string) => {
      if (!bead || newSpecId === (bead.specId || "")) return
      setFieldSaving("specId")
      const result = await trackedAction("updateBeadSpecId", () =>
        updateBeadSpecId(bead.id, newSpecId, dbPath),
      )
      if (result.success) {
        setFieldSuccess("specId")
        setSpecId(newSpecId)
        onUpdate({ ...bead, specId: newSpecId, updatedAt: new Date() })
      } else {
        setFieldError("specId")
        setSpecId(bead.specId || "")
        toastError("Failed to save spec ID", { description: result.error })
        setTimeout(() => clearFieldError("specId"), 2000)
      }
    },
    [bead, dbPath, onUpdate, setFieldSaving, setFieldSuccess, setFieldError, clearFieldError],
  )

  const handleSpecIdView = useCallback(async () => {
    if (!specId || !dbPath) return null
    const result = await readSpecFile(specId, dbPath)
    return result
  }, [specId, dbPath])

  // ---------------------------------------------------------------------------
  // Due date
  // ---------------------------------------------------------------------------
  const saveDue = useCallback(
    async (value: string) => {
      if (!bead) return
      setFieldSaving("dueAt")
      const result = await trackedAction("updateBeadDue", () =>
        updateBeadDue(bead.id, value, dbPath),
      )
      if (result.success) {
        setFieldSuccess("dueAt")
        onUpdate({ ...bead, dueAt: value ? new Date(value) : undefined, updatedAt: new Date() })
      } else {
        setFieldError("dueAt")
        toastError("Failed to save due date", { description: result.error })
        setTimeout(() => clearFieldError("dueAt"), 2000)
      }
    },
    [bead, dbPath, onUpdate, setFieldSaving, setFieldSuccess, setFieldError, clearFieldError],
  )

  // ---------------------------------------------------------------------------
  // Defer date
  // ---------------------------------------------------------------------------
  const saveDefer = useCallback(
    async (value: string) => {
      if (!bead) return
      setFieldSaving("deferUntil")
      const result = await trackedAction("updateBeadDefer", () =>
        updateBeadDefer(bead.id, value, dbPath),
      )
      if (result.success) {
        setFieldSuccess("deferUntil")
        onUpdate({
          ...bead,
          deferUntil: value ? new Date(value) : undefined,
          updatedAt: new Date(),
        })
      } else {
        setFieldError("deferUntil")
        toastError("Failed to save defer date", { description: result.error })
        setTimeout(() => clearFieldError("deferUntil"), 2000)
      }
    },
    [bead, dbPath, onUpdate, setFieldSaving, setFieldSuccess, setFieldError, clearFieldError],
  )

  // ---------------------------------------------------------------------------
  // Estimate
  // ---------------------------------------------------------------------------
  const saveEstimate = useCallback(
    async (value: number) => {
      if (!bead) return
      setFieldSaving("estimatedMinutes")
      const result = await trackedAction("updateBeadEstimate", () =>
        updateBeadEstimate(bead.id, value, dbPath),
      )
      if (result.success) {
        setFieldSuccess("estimatedMinutes")
        setEstimatedMinutes(value || undefined)
        onUpdate({ ...bead, estimatedMinutes: value || undefined, updatedAt: new Date() })
      } else {
        setFieldError("estimatedMinutes")
        toastError("Failed to save estimate", { description: result.error })
        setTimeout(() => clearFieldError("estimatedMinutes"), 2000)
      }
    },
    [bead, dbPath, onUpdate, setFieldSaving, setFieldSuccess, setFieldError, clearFieldError],
  )

  // ---------------------------------------------------------------------------
  // Design
  // ---------------------------------------------------------------------------
  const saveDesign = useCallback(
    async (value: string) => {
      if (!bead || value === (bead.design || "")) return
      setFieldSaving("design")
      const result = await trackedAction("updateBeadDesign", () =>
        updateBeadDesign(bead.id, value, dbPath),
      )
      if (result.success) {
        setFieldSuccess("design")
        setDesign(value)
        onUpdate({ ...bead, design: value, updatedAt: new Date() })
      } else {
        setFieldError("design")
        setDesign(bead.design || "")
        toastError("Failed to save design", { description: result.error })
        setTimeout(() => clearFieldError("design"), 2000)
      }
    },
    [bead, dbPath, onUpdate, setFieldSaving, setFieldSuccess, setFieldError, clearFieldError],
  )

  const saveTextField = useCallback(
    async (
      field: "description" | "acceptanceCriteria" | "notes",
      value: string,
    ): Promise<boolean> => {
      if (!bead) return false
      if (value === (bead[field] || "")) return true
      setFieldSaving(field)
      const result = await trackedAction("updateBeadTextField", () =>
        updateBeadTextField(bead.id, field, value, dbPath),
      )
      if (result.success) {
        setFieldSuccess(field)
        if (field === "description") setDescription(value)
        if (field === "acceptanceCriteria") setAcceptanceCriteria(value)
        if (field === "notes") setNotes(value)
        onUpdate({ ...bead, [field]: value, updatedAt: new Date() })
        captureDetailPanelAction("edit_field", bead.type)
        return true
      }
      setFieldError(field)
      toastError(`Failed to save ${field}`, { description: result.error })
      return false
    },
    [bead, dbPath, onUpdate, setFieldSaving, setFieldSuccess, setFieldError],
  )

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------
  const [newLabel, setNewLabel] = useState("")

  const handleAddLabel = useCallback(async () => {
    if (!bead || !newLabel.trim() || labels.includes(newLabel.trim())) return
    const labelToAdd = newLabel.trim()
    setLabels([...labels, labelToAdd])
    setNewLabel("")
    const result = await trackedAction("addLabelAction", () =>
      addLabelAction(bead.id, labelToAdd, dbPath),
    )
    if (result.success) {
      onUpdate({ ...bead, labels: [...labels, labelToAdd], updatedAt: new Date() })
    } else {
      setLabels(labels)
      toastError("Failed to add label", { description: result.error })
    }
  }, [bead, newLabel, labels, dbPath, onUpdate])

  const handleRemoveLabel = useCallback(
    async (label: string) => {
      if (!bead) return
      const prevLabels = labels
      setLabels(labels.filter((l) => l !== label))
      const result = await trackedAction("removeLabelAction", () =>
        removeLabelAction(bead.id, label, dbPath),
      )
      if (result.success) {
        onUpdate({ ...bead, labels: prevLabels.filter((l) => l !== label), updatedAt: new Date() })
      } else {
        setLabels(prevLabels)
        toastError("Failed to remove label", { description: result.error })
      }
    },
    [bead, labels, dbPath, onUpdate],
  )

  // ---------------------------------------------------------------------------
  // Dependencies
  // ---------------------------------------------------------------------------
  const handleRemoveDependency = useCallback(
    async (depId: string, direction: "blockedBy" | "blocks") => {
      if (!bead) return
      const [issueId, dependsOnId] = direction === "blockedBy" ? [bead.id, depId] : [depId, bead.id]
      const prevBlockedBy = bead.blockedBy || []
      const prevBlocks = bead.blocks || []
      const updated =
        direction === "blockedBy"
          ? {
              ...bead,
              blockedBy: prevBlockedBy.filter((d) => d.id !== depId),
              updatedAt: new Date(),
            }
          : { ...bead, blocks: prevBlocks.filter((d) => d.id !== depId), updatedAt: new Date() }
      onUpdate(updated)
      const result = await trackedAction("removeDependencyAction", () =>
        removeDependencyAction(issueId, dependsOnId, dbPath),
      )
      if (!result.success) {
        onUpdate(bead)
        toastError("Failed to remove dependency", { description: result.error })
      }
    },
    [bead, dbPath, onUpdate],
  )

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------
  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      if (!bead || !dbPath) return
      const result = await trackedAction("deleteCommentAction", () =>
        deleteCommentAction(commentId, dbPath),
      )
      if (result.success) {
        onUpdate({ ...bead, comments: bead.comments.filter((c) => c.id !== commentId) })
        toast.success("Comment deleted")
      } else {
        toastError("Failed to delete comment", { description: result.error })
      }
    },
    [bead, dbPath, onUpdate],
  )

  return {
    // Field values
    title,
    setTitle,
    description,
    design,
    acceptanceCriteria,
    notes,
    type,
    status,
    priority,
    assignee,
    labels,
    specId,
    dueAt,
    deferUntil,
    estimatedMinutes,
    newLabel,
    setNewLabel,

    // Field states
    fieldStates,

    // Handlers
    handleTitleChange,
    handleTypeChange,
    handleStatusChange,
    handlePriorityChange,
    handleAssigneeChange,
    saveSpecId,
    handleSpecIdView,
    saveDue,
    saveDefer,
    saveEstimate,
    saveDesign,
    saveTextField,
    handleAddLabel,
    handleRemoveLabel,
    handleRemoveDependency,
    handleDeleteComment,
  }
}
