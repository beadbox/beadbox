"use client"

import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  ExternalLink,
  FileText,
  PauseCircle,
  Timer,
  X,
} from "lucide-react"
import {
  formatDate,
  formatRelativeTime,
  getAuthorColor,
  getStatusDisplayConfig,
  typeColors,
} from "@/components/bead-detail-helpers"
import { CopyableId } from "@/components/copyable-id"
import { SimpleMarkdown } from "@/components/simple-markdown"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { CommentSortOrder } from "@/lib/local-storage"
import type { Bead, Comment } from "@/lib/types"
import { cn } from "@/lib/utils"

interface BeadExpandedViewModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bead: Bead
  // Field values from the hook (may differ from bead during optimistic updates)
  type: string
  status: string
  priority: string
  assignee: string
  labels: string[]
  specId: string
  description: string
  design: string
  acceptanceCriteria: string
  notes: string
  dueAt?: Date
  deferUntil?: Date
  estimatedMinutes?: number
  // Comment data
  commentSort: CommentSortOrder
  onSortChange: () => void
  groupedComments: { label: string; comments: Comment[] }[]
  // Actions
  onBeadNavigate?: (beadId: string) => void
  onRemoveDependency: (depId: string, direction: "blockedBy" | "blocks") => void
}

export function BeadExpandedViewModal({
  open,
  onOpenChange,
  bead,
  type,
  status,
  priority,
  assignee,
  labels,
  specId,
  description,
  design,
  acceptanceCriteria,
  notes,
  dueAt,
  deferUntil,
  estimatedMinutes,
  commentSort,
  onSortChange,
  groupedComments,
  onBeadNavigate,
  onRemoveDependency,
}: BeadExpandedViewModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[95vw] md:!w-[85vw] !max-w-[95vw] md:!max-w-[85vw] max-h-[95vh] md:max-h-[90vh] h-[95vh] md:h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span
                className={cn(
                  "px-2 py-1 text-xs font-medium rounded border capitalize shrink-0",
                  typeColors[type],
                )}
              >
                {type}
              </span>
              <DialogTitle className="text-lg font-semibold text-foreground/70 truncate">
                {bead.title}
              </DialogTitle>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-2 flex-wrap">
            <CopyableId id={bead.id} className="text-xs" />
            {bead.externalRef && (
              <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">
                {bead.externalRef}
              </span>
            )}
            {specId &&
              (specId.startsWith("http") ? (
                <a
                  href={specId}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-medium hover:bg-indigo-500/30 transition-colors"
                >
                  <ExternalLink className="h-3 w-3" />
                  <span className="truncate max-w-[200px]">{specId}</span>
                </a>
              ) : (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-medium">
                  <FileText className="h-3 w-3" />
                  <span className="truncate max-w-[200px]">{specId}</span>
                </span>
              ))}
            {bead.createdAt && (
              <span title={formatDate(bead.createdAt)}>
                Created: {formatRelativeTime(bead.createdAt)}
              </span>
            )}
            {bead.updatedAt && (
              <span title={formatDate(bead.updatedAt)}>
                Updated: {formatRelativeTime(bead.updatedAt)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-2 text-[13px] text-muted-foreground">
            <span className={getStatusDisplayConfig(status).colorClass}>
              {getStatusDisplayConfig(status).label}
            </span>
            <span className="text-border">|</span>
            <span
              className={cn(
                priority === "critical" && "text-red-400",
                priority === "high" && "text-orange-400",
                priority === "medium" && "text-yellow-400",
                priority === "low" && "text-slate-400",
                priority === "backlog" && "text-zinc-500",
              )}
            >
              {priority === "critical"
                ? "P0 - Critical"
                : priority === "high"
                  ? "P1 - High"
                  : priority === "medium"
                    ? "P2 - Medium"
                    : priority === "low"
                      ? "P3 - Low"
                      : priority === "backlog"
                        ? "P4 - Backlog"
                        : priority}
            </span>
            {assignee && (
              <>
                <span className="text-border">|</span>
                <span>{assignee}</span>
              </>
            )}
            {labels.length > 0 && (
              <>
                <span className="text-border">|</span>
                <div className="flex items-center gap-1">
                  {labels.map((label) => (
                    <span key={label} className="text-[13px] text-muted-foreground">
                      {label}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
          {(dueAt || deferUntil || estimatedMinutes) && (
            <div className="flex items-center gap-3 mt-1 text-[13px] text-muted-foreground">
              {dueAt && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    new Date(dueAt) < new Date() ? "text-red-400" : "text-blue-400",
                  )}
                >
                  <CalendarClock className="h-3 w-3" />
                  Due:{" "}
                  {new Date(dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
              )}
              {deferUntil && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    new Date(deferUntil) > new Date() ? "text-amber-400" : "text-zinc-400",
                  )}
                >
                  <PauseCircle className="h-3 w-3" />
                  Defer:{" "}
                  {new Date(deferUntil).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              )}
              {estimatedMinutes && (
                <span className="inline-flex items-center gap-1 text-zinc-400">
                  <Timer className="h-3 w-3" />
                  Est:{" "}
                  {estimatedMinutes >= 60
                    ? `${Math.round(estimatedMinutes / 60)}h`
                    : `${estimatedMinutes}m`}
                </span>
              )}
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* Description */}
          <div>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Description
            </h3>
            <div className="prose prose-sm prose-invert max-w-none text-foreground/90">
              {description ? (
                <SimpleMarkdown content={description} />
              ) : (
                <p className="text-muted-foreground/50 italic text-sm">No description</p>
              )}
            </div>
          </div>

          {/* Design */}
          {design && (
            <div className="pt-4 border-t border-border/30">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Design
              </h3>
              <div className="prose prose-sm prose-invert max-w-none text-foreground/90">
                <SimpleMarkdown content={design} />
              </div>
            </div>
          )}

          {/* Acceptance Criteria */}
          {acceptanceCriteria && (
            <div className="pt-4 border-t border-border/30">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Acceptance Criteria
              </h3>
              <div className="prose prose-sm prose-invert max-w-none text-foreground/90">
                <SimpleMarkdown content={acceptanceCriteria} />
              </div>
            </div>
          )}

          {/* Notes */}
          {notes && (
            <div className="pt-4 border-t border-border/30">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Notes
              </h3>
              <div className="prose prose-sm prose-invert max-w-none text-foreground/90">
                <SimpleMarkdown content={notes} />
              </div>
            </div>
          )}

          {/* Custom Fields (metadata) */}
          {Object.keys(bead.metadata || {}).length > 0 && (
            <div className="pt-4 border-t border-border/30">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Custom Fields
              </h3>
              <div className="space-y-1">
                {Object.entries(bead.metadata!).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{key}</span>
                    <span className="text-foreground/90">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dependencies */}
          {bead.blockedBy?.length || bead.blocks?.length ? (
            <div className="pt-4 border-t border-border/30 space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Dependencies
              </h3>
              {bead.blockedBy && bead.blockedBy.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Blocked by:</span>
                  {bead.blockedBy.map((dep) => (
                    <span key={dep.id} className="inline-flex items-center">
                      <button
                        onClick={() => {
                          onOpenChange(false)
                          onBeadNavigate?.(dep.id)
                        }}
                        className="text-xs px-2 py-0.5 rounded-l bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                        title={dep.title}
                      >
                        {dep.id}
                      </button>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => onRemoveDependency(dep.id, "blockedBy")}
                              className="text-xs px-1 py-0.5 rounded-r bg-red-500/10 text-red-400/60 hover:text-red-300 hover:bg-red-500/30 transition-colors border-l border-red-500/20"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Remove dependency</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </span>
                  ))}
                </div>
              )}
              {bead.blocks && bead.blocks.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Blocks:</span>
                  {bead.blocks.map((dep) => (
                    <span key={dep.id} className="inline-flex items-center">
                      <button
                        onClick={() => {
                          onOpenChange(false)
                          onBeadNavigate?.(dep.id)
                        }}
                        className="text-xs px-2 py-0.5 rounded-l bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors"
                        title={dep.title}
                      >
                        {dep.id}
                      </button>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => onRemoveDependency(dep.id, "blocks")}
                              className="text-xs px-1 py-0.5 rounded-r bg-amber-500/10 text-amber-400/60 hover:text-amber-300 hover:bg-amber-500/30 transition-colors border-l border-amber-500/20"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Remove dependency</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* Comments */}
          {bead.comments.length > 0 && (
            <div className="pt-4 border-t border-border/30 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Comments ({bead.comments.length})
                </h3>
                <button
                  type="button"
                  onClick={onSortChange}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted/50"
                >
                  {commentSort === "newest" ? (
                    <ArrowDown className="h-3 w-3" />
                  ) : (
                    <ArrowUp className="h-3 w-3" />
                  )}
                  {commentSort === "newest" ? "Newest" : "Oldest"}
                </button>
              </div>
              {groupedComments.map((group) => (
                <div key={group.label}>
                  <div className="text-xs text-muted-foreground/50 uppercase tracking-wide py-1">
                    {group.label}
                  </div>
                  <div className="space-y-4">
                    {group.comments.map((comment) => (
                      <div
                        key={comment.id}
                        className={cn(
                          "rounded-xl bg-card shadow-md shadow-black/20 overflow-hidden border-l-2",
                          getAuthorColor(comment.author),
                        )}
                      >
                        <div className="group flex items-center gap-3 px-4 py-2.5 bg-muted/30 border-b border-border/20">
                          <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold bg-primary/20 text-primary">
                            {comment.author.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-sm text-foreground/70">
                            {comment.author}
                          </span>
                          <span className="text-xs text-muted-foreground/60 ml-auto">
                            {formatRelativeTime(comment.timestamp)}
                          </span>
                        </div>
                        <div className="px-4 py-3 text-sm text-foreground/90">
                          <SimpleMarkdown content={comment.content} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
