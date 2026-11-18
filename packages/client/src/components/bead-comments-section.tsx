"use client"

import { ArrowDown, ArrowUp, Maximize2, Trash2 } from "lucide-react"
import {
  formatDateTime,
  formatRelativeTime,
  getAuthorColor,
} from "@/components/bead-detail-helpers"
import { SimpleMarkdown } from "@/components/simple-markdown"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { CommentSortOrder } from "@/lib/local-storage"
import type { Comment } from "@/lib/types"
import { cn } from "@/lib/utils"

function CommentSkeletonCard() {
  return (
    <div className="rounded-xl bg-card shadow-md shadow-black/20 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/30 border-b border-border/20">
        <Skeleton className="w-7 h-7 rounded-full flex-shrink-0" />
        <Skeleton className="w-20 h-3.5 rounded" />
        <Skeleton className="w-12 h-3 rounded ml-auto" />
      </div>
      <div className="px-4 py-3 space-y-2">
        <Skeleton className="w-full h-3.5 rounded" />
        <Skeleton className="w-3/4 h-3.5 rounded" />
      </div>
    </div>
  )
}

interface CommentsSectionProps {
  commentsCount: number
  sortedComments: Comment[]
  groupedComments: { label: string; comments: Comment[] }[]
  commentSort: CommentSortOrder
  onSortChange: () => void
  onDeleteComment: (commentId: string) => void
  onExpandComment: (comment: Comment) => void
  isLoadingBead: boolean
  isMobile: boolean
  focusedCommentIndex: number | null
  onCommentClick: (index: number) => void
  commentRefs: React.MutableRefObject<(HTMLDivElement | null)[]>
  firstCommentRef: React.MutableRefObject<HTMLDivElement | null>
  lastCommentRef: React.MutableRefObject<HTMLDivElement | null>
}

export function CommentsSection({
  commentsCount,
  sortedComments,
  groupedComments,
  commentSort,
  onSortChange,
  onDeleteComment,
  onExpandComment,
  isLoadingBead,
  isMobile,
  focusedCommentIndex,
  onCommentClick,
  commentRefs,
  firstCommentRef,
  lastCommentRef,
}: CommentsSectionProps) {
  return (
    <>
      {/* Skeleton during initial load */}
      {isLoadingBead && commentsCount === 0 && (
        <div className="mt-6 space-y-4 transition-opacity duration-150">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Activity (...)
            </h3>
            <span className="flex items-center gap-1 text-xs text-muted-foreground/40 px-2 py-1 rounded cursor-default">
              {commentSort === "newest" ? (
                <ArrowDown className="h-3 w-3" />
              ) : (
                <ArrowUp className="h-3 w-3" />
              )}
              {commentSort === "newest" ? "Newest" : "Oldest"}
            </span>
          </div>
          <div className="space-y-4">
            <CommentSkeletonCard />
            <CommentSkeletonCard />
          </div>
        </div>
      )}

      {commentsCount > 0 && (
        <div className="mt-6 space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Activity ({commentsCount})
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
          {(() => {
            let flatIndex = 0
            return groupedComments.map((group) => (
              <div key={group.label}>
                <div className="text-xs text-muted-foreground/50 uppercase tracking-wide py-1">
                  {group.label}
                </div>
                <div className="space-y-4">
                  {group.comments.map((comment) => {
                    const idx = flatIndex++
                    return (
                      <div
                        key={comment.id}
                        ref={(el) => {
                          commentRefs.current[idx] = el
                          if (idx === 0) firstCommentRef.current = el
                          if (idx === sortedComments.length - 1) lastCommentRef.current = el
                        }}
                        className={cn(
                          "rounded-xl bg-card shadow-md shadow-black/20 overflow-hidden transition-all cursor-pointer scroll-mt-2 border-l-2",
                          getAuthorColor(comment.author),
                          focusedCommentIndex === idx && "ring-1 ring-primary/60",
                          idx === sortedComments.length - 1 && "mb-12",
                        )}
                        onClick={() => onCommentClick(idx)}
                      >
                        <div className="group flex items-center gap-3 px-4 py-2.5 bg-muted/30 border-b border-border/20">
                          <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold bg-primary/20 text-primary">
                            {comment.author.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-sm text-foreground/70">
                            {comment.author}
                          </span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-xs text-muted-foreground/60 cursor-default ml-auto">
                                {formatRelativeTime(comment.timestamp)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{formatDateTime(comment.timestamp)}</TooltipContent>
                          </Tooltip>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onExpandComment(comment)
                            }}
                            className={cn(
                              "p-1 rounded hover:bg-muted text-muted-foreground/40 hover:text-foreground transition-colors opacity-0 group-hover:opacity-100",
                              isMobile &&
                                "min-h-[44px] min-w-[44px] flex items-center justify-center opacity-100",
                            )}
                            title="Expand comment"
                          >
                            <Maximize2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onDeleteComment(comment.id)
                            }}
                            className={cn(
                              "p-1 rounded hover:bg-destructive/20 text-muted-foreground/40 hover:text-destructive-text transition-colors opacity-0 group-hover:opacity-100",
                              isMobile &&
                                "min-h-[44px] min-w-[44px] flex items-center justify-center opacity-100",
                            )}
                            title="Delete comment"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="px-4 py-3 text-sm text-foreground/90">
                          <SimpleMarkdown content={comment.content} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          })()}
        </div>
      )}
    </>
  )
}
