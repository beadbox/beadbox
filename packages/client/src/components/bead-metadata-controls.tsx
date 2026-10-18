"use client"

import { Plus, X } from "lucide-react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import {
  type FieldState,
  getStatusDisplayConfig,
  normalizeNewLabel,
} from "@/components/bead-detail-helpers"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { BeadPriority, BeadStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

interface MetadataControlsProps {
  status: BeadStatus
  priority: BeadPriority
  assignee: string
  labels: string[]
  /** Labels in use across the workspace, offered as suggestions when adding. */
  availableLabels: string[]
  availableStatuses: string[]
  assignees: string[]
  fieldStates: {
    status: FieldState
    priority: FieldState
    assignee: FieldState
  }
  onStatusChange: (status: BeadStatus) => void
  onPriorityChange: (priority: BeadPriority) => void
  onAssigneeChange: (assignee: string) => void
  onAddLabel: (label: string) => void
  onRemoveLabel: (label: string) => void
  isMobile: boolean
}

export function MetadataControls({
  status,
  priority,
  assignee,
  labels,
  availableLabels,
  availableStatuses,
  assignees,
  fieldStates,
  onStatusChange,
  onPriorityChange,
  onAssigneeChange,
  onAddLabel,
  onRemoveLabel,
  isMobile,
}: MetadataControlsProps) {
  const [isAddingAssignee, setIsAddingAssignee] = useState(false)
  const [newAssigneeName, setNewAssigneeName] = useState("")

  const handleAddNewAssignee = useCallback(() => {
    if (!newAssigneeName.trim()) return
    const trimmed = newAssigneeName.trim()
    setIsAddingAssignee(false)
    setNewAssigneeName("")
    onAssigneeChange(trimmed)
  }, [newAssigneeName, onAssigneeChange])

  // Add label (beadbox-m4i): the same inline-input pattern as the assignee.
  const [isAddingLabel, setIsAddingLabel] = useState(false)
  const [newLabelText, setNewLabelText] = useState("")
  const addLabelButtonRef = useRef<HTMLButtonElement>(null)
  const refocusAddLabel = useRef(false)
  const labelSuggestionsId = useId()
  const newLabel = normalizeNewLabel(newLabelText, labels)
  const labelSuggestions = availableLabels.filter((l) => !labels.includes(l))

  const closeLabelInput = useCallback(() => {
    refocusAddLabel.current = true
    setIsAddingLabel(false)
    setNewLabelText("")
  }, [])

  const handleAddNewLabel = useCallback(() => {
    if (newLabel === null) return
    onAddLabel(newLabel)
    closeLabelInput()
  }, [newLabel, onAddLabel, closeLabelInput])

  // Keyboard users land back on the + once the input closes.
  useEffect(() => {
    if (isAddingLabel || !refocusAddLabel.current) return
    refocusAddLabel.current = false
    addLabelButtonRef.current?.focus()
  }, [isAddingLabel])

  return (
    <div className="flex flex-wrap items-center gap-2 md:gap-3 mt-2 text-[13px] text-muted-foreground">
      {/* Status */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <Select value={status} onValueChange={(value: BeadStatus) => onStatusChange(value)}>
              <SelectTrigger
                disabled={fieldStates.status.isSaving}
                className={cn(
                  "h-auto min-h-[44px] md:min-h-0 p-0 border-0 bg-transparent dark:bg-transparent dark:hover:bg-transparent shadow-none rounded-none w-auto gap-1 text-[13px]",
                  getStatusDisplayConfig(status).colorClass,
                  fieldStates.status.hasError && "ring-1 ring-destructive",
                )}
              >
                {fieldStates.status.isSaving ? <Spinner className="h-2 w-2" /> : <SelectValue />}
              </SelectTrigger>
              <SelectContent>
                {availableStatuses.map((s) => {
                  const config = getStatusDisplayConfig(s)
                  return (
                    <SelectItem key={s} value={s}>
                      <span className="flex items-center gap-1.5">
                        <span className={cn("w-1.5 h-1.5 rounded-full", config.dotClass)} />
                        {config.label}
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
        </TooltipTrigger>
        <TooltipContent>Change status</TooltipContent>
      </Tooltip>

      <span className="text-border">|</span>

      {/* Priority */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <Select
              value={priority}
              onValueChange={(value: BeadPriority) => onPriorityChange(value)}
            >
              <SelectTrigger
                disabled={fieldStates.priority.isSaving}
                className={cn(
                  "h-auto min-h-[44px] md:min-h-0 p-0 border-0 bg-transparent dark:bg-transparent dark:hover:bg-transparent shadow-none rounded-none w-auto gap-1 text-[13px]",
                  priority === "critical" && "text-red-400",
                  priority === "high" && "text-orange-400",
                  priority === "medium" && "text-yellow-400",
                  priority === "low" && "text-slate-400",
                  priority === "backlog" && "text-zinc-500",
                  fieldStates.priority.hasError && "ring-1 ring-destructive",
                )}
              >
                {fieldStates.priority.isSaving ? <Spinner className="h-2 w-2" /> : <SelectValue />}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                    P0 - Critical
                  </span>
                </SelectItem>
                <SelectItem value="high">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                    P1 - High
                  </span>
                </SelectItem>
                <SelectItem value="medium">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                    P2 - Medium
                  </span>
                </SelectItem>
                <SelectItem value="low">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                    P3 - Low
                  </span>
                </SelectItem>
                <SelectItem value="backlog">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
                    P4 - Backlog
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </TooltipTrigger>
        <TooltipContent>Change priority</TooltipContent>
      </Tooltip>

      <span className="text-border">|</span>

      {/* Assignee */}
      {isAddingAssignee ? (
        <div className="flex items-center gap-1">
          <input
            value={newAssigneeName}
            onChange={(e) => setNewAssigneeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddNewAssignee()
              if (e.key === "Escape") {
                setIsAddingAssignee(false)
                setNewAssigneeName("")
              }
            }}
            placeholder="Name..."
            autoFocus
            className="w-24 md:w-16 bg-transparent border-b border-border text-foreground text-[13px] outline-none"
          />
          <button
            onClick={handleAddNewAssignee}
            disabled={!newAssigneeName.trim()}
            className="text-primary hover:text-primary/80"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Select
                value={assignee || "_none"}
                onValueChange={(value) => {
                  if (value === "_add_new") {
                    setIsAddingAssignee(true)
                  } else if (value === "_none") {
                    onAssigneeChange("")
                  } else {
                    onAssigneeChange(value)
                  }
                }}
              >
                <SelectTrigger
                  disabled={fieldStates.assignee.isSaving}
                  className={cn(
                    "h-auto min-h-[44px] md:min-h-0 p-0 border-0 bg-transparent dark:bg-transparent dark:hover:bg-transparent shadow-none rounded-none w-auto gap-1 text-[13px] text-foreground/70",
                    !assignee && "text-muted-foreground",
                    fieldStates.assignee.hasError && "ring-1 ring-destructive",
                  )}
                >
                  {fieldStates.assignee.isSaving ? (
                    <Spinner className="h-2 w-2" />
                  ) : (
                    <SelectValue placeholder="assignee" />
                  )}
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">
                    <span className="text-muted-foreground">None</span>
                  </SelectItem>
                  {assignees.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                  <SelectItem value="_add_new" className="text-primary">
                    <span className="flex items-center gap-1.5">
                      <Plus className="h-3 w-3" />
                      Add new...
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </TooltipTrigger>
          <TooltipContent>Change assignee</TooltipContent>
        </Tooltip>
      )}

      {/* Labels */}
      <span className="text-border">|</span>
      <div className="flex flex-wrap items-center gap-1">
        {labels.map((label) => (
          <span key={label} className="text-[13px] text-muted-foreground flex items-center">
            {label}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onRemoveLabel(label)}
                  className={cn(
                    "ml-0.5 hover:text-red-400",
                    isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center -mr-3",
                  )}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Remove label</TooltipContent>
            </Tooltip>
          </span>
        ))}
        {isAddingLabel ? (
          <div className="flex items-center gap-1">
            <input
              value={newLabelText}
              onChange={(e) => setNewLabelText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleAddNewLabel()
                }
                if (e.key === "Escape") closeLabelInput()
              }}
              aria-label="New label"
              list={labelSuggestionsId}
              // A label is stored exactly as typed: no autocorrect or capitals.
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Label..."
              autoFocus
              className="w-24 bg-transparent border-b border-border text-foreground text-[13px] outline-none"
            />
            <datalist id={labelSuggestionsId}>
              {labelSuggestions.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            <button
              onClick={handleAddNewLabel}
              disabled={newLabel === null}
              aria-label="Save label"
              className="text-primary hover:text-primary/80 disabled:opacity-50"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={addLabelButtonRef}
                onClick={() => setIsAddingLabel(true)}
                onKeyDown={(e) => {
                  // The tree's window keydown handler treats Enter and Space
                  // outside an input as "open the focused bead" and calls
                  // preventDefault, which cancels this button's activation.
                  // Handle both here and keep them from reaching it.
                  if (e.key !== "Enter" && e.key !== " ") return
                  e.preventDefault()
                  e.stopPropagation()
                  setIsAddingLabel(true)
                }}
                aria-label="Add label"
                className={cn(
                  "hover:text-foreground",
                  isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                )}
              >
                <Plus className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add label</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
