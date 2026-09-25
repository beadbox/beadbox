"use client"

import { CalendarClock, PauseCircle, Timer } from "lucide-react"
import { useCallback, useState } from "react"
import type { FieldState } from "@/components/bead-detail-helpers"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface SchedulingControlsProps {
  dueAt?: Date
  deferUntil?: Date
  estimatedMinutes?: number
  fieldStates: {
    dueAt: FieldState
    deferUntil: FieldState
    estimatedMinutes: FieldState
  }
  onSaveDue: (value: string) => void
  onSaveDefer: (value: string) => void
  onSaveEstimate: (value: number) => void
  isMobile: boolean
  beadId?: string
}

export function SchedulingControls({
  dueAt,
  deferUntil,
  estimatedMinutes,
  fieldStates,
  onSaveDue,
  onSaveDefer,
  onSaveEstimate,
  isMobile,
}: SchedulingControlsProps) {
  const [isEditingDue, setIsEditingDue] = useState(false)
  const [editDueValue, setEditDueValue] = useState("")
  const [isEditingDefer, setIsEditingDefer] = useState(false)
  const [editDeferValue, setEditDeferValue] = useState("")
  const [isEditingEstimate, setIsEditingEstimate] = useState(false)
  const [editEstimateValue, setEditEstimateValue] = useState("")

  const handleDueSave = useCallback(() => {
    setIsEditingDue(false)
    onSaveDue(editDueValue.trim())
  }, [editDueValue, onSaveDue])

  const handleDeferSave = useCallback(() => {
    setIsEditingDefer(false)
    onSaveDefer(editDeferValue.trim())
  }, [editDeferValue, onSaveDefer])

  const handleEstimateSave = useCallback(() => {
    setIsEditingEstimate(false)
    const num = parseInt(editEstimateValue, 10)
    onSaveEstimate(Number.isNaN(num) ? 0 : num)
  }, [editEstimateValue, onSaveEstimate])

  return (
    <div className="flex flex-wrap items-center gap-2 md:gap-3 mt-1.5 text-sm text-muted-foreground">
      {/* Due */}
      {isEditingDue ? (
        <div className="flex items-center gap-1">
          <CalendarClock className="h-3.5 w-3.5 shrink-0" />
          <input
            value={editDueValue}
            onChange={(e) => setEditDueValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleDueSave()
              if (e.key === "Escape") {
                setIsEditingDue(false)
                setEditDueValue("")
              }
            }}
            onBlur={handleDueSave}
            placeholder="due date (+1d, tomorrow, 2026-02-14...)"
            autoFocus
            className="w-full md:w-48 bg-transparent border-b border-border text-foreground text-sm outline-none"
          />
        </div>
      ) : dueAt ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => {
                setEditDueValue("")
                setIsEditingDue(true)
              }}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium transition-colors",
                new Date(dueAt) < new Date()
                  ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  : "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30",
              )}
            >
              <CalendarClock className="h-3 w-3" />
              <span className="text-xs">
                Due:{" "}
                {new Date(dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {new Date(dueAt) < new Date() ? "Overdue! " : ""}Click to edit
          </TooltipContent>
        </Tooltip>
      ) : (
        <button
          onClick={() => {
            setEditDueValue("")
            setIsEditingDue(true)
          }}
          className={cn(
            "inline-flex items-center gap-1 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors",
            isMobile && "min-h-[44px]",
          )}
        >
          <CalendarClock className="h-3 w-3" />
          <span>Add due</span>
        </button>
      )}
      {fieldStates.dueAt.isSaving && <Spinner className="h-3 w-3" />}

      {/* Defer */}
      {isEditingDefer ? (
        <div className="flex items-center gap-1">
          <PauseCircle className="h-3.5 w-3.5 shrink-0" />
          <input
            value={editDeferValue}
            onChange={(e) => setEditDeferValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleDeferSave()
              if (e.key === "Escape") {
                setIsEditingDefer(false)
                setEditDeferValue("")
              }
            }}
            onBlur={handleDeferSave}
            placeholder="defer until (+6h, monday...)"
            autoFocus
            className="w-full md:w-44 bg-transparent border-b border-border text-foreground text-sm outline-none"
          />
        </div>
      ) : deferUntil ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => {
                setEditDeferValue("")
                setIsEditingDefer(true)
              }}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium transition-colors",
                new Date(deferUntil) > new Date()
                  ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
                  : "bg-zinc-500/20 text-zinc-400 hover:bg-zinc-500/30",
              )}
            >
              <PauseCircle className="h-3 w-3" />
              <span className="text-xs">
                Defer:{" "}
                {new Date(deferUntil).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {new Date(deferUntil) > new Date() ? "Currently deferred. " : ""}Click to edit
          </TooltipContent>
        </Tooltip>
      ) : (
        <button
          onClick={() => {
            setEditDeferValue("")
            setIsEditingDefer(true)
          }}
          className={cn(
            "inline-flex items-center gap-1 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors",
            isMobile && "min-h-[44px]",
          )}
        >
          <PauseCircle className="h-3 w-3" />
          <span>Add defer</span>
        </button>
      )}
      {fieldStates.deferUntil.isSaving && <Spinner className="h-3 w-3" />}

      {/* Estimate */}
      {isEditingEstimate ? (
        <div className="flex items-center gap-1">
          <Timer className="h-3.5 w-3.5 shrink-0" />
          <input
            type="number"
            value={editEstimateValue}
            onChange={(e) => setEditEstimateValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleEstimateSave()
              if (e.key === "Escape") {
                setIsEditingEstimate(false)
                setEditEstimateValue("")
              }
            }}
            onBlur={handleEstimateSave}
            placeholder="minutes"
            autoFocus
            className="w-20 bg-transparent border-b border-border text-foreground text-sm outline-none"
          />
          <span className="text-xs text-muted-foreground/50">min</span>
        </div>
      ) : estimatedMinutes ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => {
                setEditEstimateValue(String(estimatedMinutes))
                setIsEditingEstimate(true)
              }}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-500/20 text-zinc-400 font-medium hover:bg-zinc-500/30 transition-colors"
            >
              <Timer className="h-3 w-3" />
              <span className="text-xs">
                Est:{" "}
                {estimatedMinutes >= 60
                  ? `${Math.round(estimatedMinutes / 60)}h`
                  : `${estimatedMinutes}m`}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{estimatedMinutes} minutes. Click to edit</TooltipContent>
        </Tooltip>
      ) : (
        <button
          onClick={() => {
            setEditEstimateValue("")
            setIsEditingEstimate(true)
          }}
          className={cn(
            "inline-flex items-center gap-1 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors",
            isMobile && "min-h-[44px]",
          )}
        >
          <Timer className="h-3 w-3" />
          <span>Add estimate</span>
        </button>
      )}
      {fieldStates.estimatedMinutes.isSaving && <Spinner className="h-3 w-3" />}
    </div>
  )
}
