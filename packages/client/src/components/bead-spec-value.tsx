"use client"

import { ExternalLink, FileText } from "lucide-react"
import type { KeyboardEvent } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface BeadSpecValueProps {
  specId: string
  isEditing: boolean
  editValue: string
  isMobile: boolean
  onEditValueChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onSave: () => void
  onEdit: () => void
  onView: () => void
}

export function BeadSpecValue({
  specId,
  isEditing,
  editValue,
  isMobile,
  onEditValueChange,
  onKeyDown,
  onSave,
  onEdit,
  onView,
}: BeadSpecValueProps) {
  if (isEditing) {
    return (
      <div className="flex items-center gap-1">
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <input
          value={editValue}
          onChange={(event) => onEditValueChange(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onSave}
          placeholder="spec path or URL..."
          autoFocus
          className="w-full md:w-48 bg-transparent border-b border-border text-foreground text-sm outline-none"
        />
      </div>
    )
  }
  if (!specId) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onEdit}
            className={cn(
              "inline-flex items-center gap-1 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors",
              isMobile && "min-h-[44px]",
            )}
          >
            <FileText className="h-3 w-3" />
            <span>Add spec</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Link a specification document</TooltipContent>
      </Tooltip>
    )
  }
  const isUrl = specId.startsWith("http")
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {isUrl ? (
          <a
            href={specId}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-medium hover:bg-indigo-500/30 transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            <span className="truncate max-w-[200px]">{specId}</span>
          </a>
        ) : (
          <button
            onClick={onView}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-medium hover:bg-indigo-500/30 transition-colors cursor-pointer"
          >
            <FileText className="h-3 w-3" />
            <span className="truncate max-w-[200px]">{specId}</span>
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent>
        {isUrl ? "Open spec (click to edit: double-click)" : "Click to view spec"}
      </TooltipContent>
    </Tooltip>
  )
}
