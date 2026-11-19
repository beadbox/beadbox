"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CommentSortOrder } from "@/lib/local-storage"
import type { Comment } from "@/lib/types"

interface UseCommentNavigationOptions {
  bead: { id: string; comments: Comment[] } | null
  commentSort: CommentSortOrder
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  isFocused: boolean
}

export function useCommentNavigation({
  bead,
  commentSort,
  scrollContainerRef,
  isFocused,
}: UseCommentNavigationOptions) {
  const firstCommentRef = useRef<HTMLDivElement | null>(null)
  const lastCommentRef = useRef<HTMLDivElement | null>(null)
  const commentRefs = useRef<(HTMLDivElement | null)[]>([])
  const [focusedCommentIndex, setFocusedCommentIndex] = useState<number | null>(null)

  // Sorted comments
  const sortedComments = useMemo(() => {
    if (!bead) return []
    const comments = [...bead.comments]
    comments.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime()
      const tb = new Date(b.timestamp).getTime()
      return commentSort === "newest" ? tb - ta : ta - tb
    })
    return comments
  }, [bead, commentSort])

  // Grouped comments
  const groupedComments = useMemo(() => {
    if (sortedComments.length === 0) return []
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterdayStart = new Date(todayStart.getTime() - 86400000)

    const groups: { label: string; comments: Comment[] }[] = []
    let currentLabel = ""

    for (const comment of sortedComments) {
      const d = new Date(comment.timestamp)
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      let label: string
      if (dayStart.getTime() >= todayStart.getTime()) {
        label = "Today"
      } else if (dayStart.getTime() >= yesterdayStart.getTime()) {
        label = "Yesterday"
      } else {
        label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      }
      if (label !== currentLabel) {
        groups.push({ label, comments: [comment] })
        currentLabel = label
      } else {
        groups[groups.length - 1].comments.push(comment)
      }
    }
    return groups
  }, [sortedComments])

  // Reset on bead change
  useEffect(() => {
    setFocusedCommentIndex(null)
  }, [bead?.id])

  // Reset focus when panel loses focus
  useEffect(() => {
    if (!isFocused) setFocusedCommentIndex(null)
  }, [isFocused])

  const navigateComments = useCallback(
    (direction: "up" | "down") => {
      if (!bead) return

      if (sortedComments.length === 0) {
        const container = scrollContainerRef.current
        if (container) {
          container.scrollBy({ top: direction === "down" ? 150 : -150, behavior: "smooth" })
        }
        return
      }

      setFocusedCommentIndex((prev) => {
        if (prev === 0 && direction === "up") {
          scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" })
          return null
        }
        if (prev === null && direction === "up") {
          scrollContainerRef.current?.scrollBy({ top: -150, behavior: "smooth" })
          return null
        }

        let newIndex: number
        if (prev === null) newIndex = 0
        else if (direction === "down") newIndex = Math.min(prev + 1, sortedComments.length - 1)
        else newIndex = Math.max(prev - 1, 0)

        setTimeout(() => {
          commentRefs.current[newIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest" })
        }, 0)

        return newIndex
      })
    },
    [bead, sortedComments, scrollContainerRef],
  )

  return {
    sortedComments,
    groupedComments,
    focusedCommentIndex,
    setFocusedCommentIndex,
    navigateComments,
    commentRefs,
    firstCommentRef,
    lastCommentRef,
  }
}
