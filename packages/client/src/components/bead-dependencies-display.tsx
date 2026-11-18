"use client"

import { X } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { BeadDependency } from "@/lib/types"
import { cn } from "@/lib/utils"

interface BeadDependenciesDisplayProps {
  blockedBy?: BeadDependency[]
  blocks?: BeadDependency[]
  onRemove: (depId: string, direction: "blockedBy" | "blocks") => void
  onNavigate?: (beadId: string) => void
  isMobile: boolean
}

export function BeadDependenciesDisplay({
  blockedBy,
  blocks,
  onRemove,
  onNavigate,
  isMobile,
}: BeadDependenciesDisplayProps) {
  if (!blockedBy?.length && !blocks?.length) return null

  return (
    <div className="pt-4 border-t border-border/30 space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Dependencies
      </h3>
      {blockedBy && blockedBy.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Blocked by:</span>
          {blockedBy.map((dep) => (
            <span key={dep.id} className="inline-flex items-center">
              <button
                onClick={() => onNavigate?.(dep.id)}
                className={cn(
                  "text-xs px-2 py-0.5 rounded-l bg-destructive/10 text-destructive-text hover:bg-destructive/20 transition-colors",
                  isMobile && "min-h-[44px]",
                )}
                title={dep.title}
              >
                {dep.id}
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onRemove(dep.id, "blockedBy")}
                    className={cn(
                      "text-xs px-1 py-0.5 rounded-r bg-destructive/10 text-destructive-text/60 hover:text-destructive-text hover:bg-destructive/30 transition-colors border-l border-destructive/20",
                      isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                    )}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Remove dependency</TooltipContent>
              </Tooltip>
            </span>
          ))}
        </div>
      )}
      {blocks && blocks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Blocks:</span>
          {blocks.map((dep) => (
            <span key={dep.id} className="inline-flex items-center">
              <button
                onClick={() => onNavigate?.(dep.id)}
                className={cn(
                  "text-xs px-2 py-0.5 rounded-l bg-warning/10 text-warning-text hover:bg-warning/20 transition-colors",
                  isMobile && "min-h-[44px]",
                )}
                title={dep.title}
              >
                {dep.id}
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onRemove(dep.id, "blocks")}
                    className={cn(
                      "text-xs px-1 py-0.5 rounded-r bg-warning/10 text-warning-text/60 hover:text-warning-text hover:bg-warning/30 transition-colors border-l border-warning/20",
                      isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                    )}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Remove dependency</TooltipContent>
              </Tooltip>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
