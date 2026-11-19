"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
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

  // beadbox-9sa: keep the reader's place when comments arrive. The comment at
  // the top of the view keeps its offset from the thread's top across a change
  // to the list (WKWebView has no CSS scroll anchoring to do it for us), so a
  // comment inserted above the reader never moves what they are reading. Only
  // the user's own scrolling (wheel, keyboard, minimap) moves the thread.
  const anchorRef = useRef<{ id: string; offset: number } | null>(null)
  const anchorBeadRef = useRef<string | undefined>(undefined)
  const sortedRef = useRef(sortedComments)

  const captureAnchor = useCallback(() => {
    const container = scrollContainerRef.current
    anchorRef.current = null
    if (!container) return
    const top = container.getBoundingClientRect().top
    const bottom = top + container.clientHeight
    const list = sortedRef.current
    for (let i = 0; i < list.length; i++) {
      const el = commentRefs.current[i]
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.bottom > top && r.top < bottom) {
        anchorRef.current = { id: list[i].id, offset: r.top - top }
        return
      }
    }
  }, [scrollContainerRef])

  // Follow the user's scrolling, so the anchor is always the comment they see.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroll container is re-created when the bead changes, so the listener must re-attach then
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.addEventListener("scroll", captureAnchor, { passive: true })
    return () => container.removeEventListener("scroll", captureAnchor)
  }, [bead?.id, scrollContainerRef, captureAnchor])

  // After the list changes, put the anchor comment back where it was, before paint.
  useLayoutEffect(() => {
    sortedRef.current = sortedComments
    const container = scrollContainerRef.current
    const anchor = anchorRef.current
    if (container && anchor && anchorBeadRef.current === bead?.id) {
      const i = sortedComments.findIndex((c) => c.id === anchor.id)
      const el = i >= 0 ? commentRefs.current[i] : null
      if (el) {
        const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
        if (Math.abs(delta) >= 1) container.scrollTop += delta
      }
    }
    anchorBeadRef.current = bead?.id
    captureAnchor()
  }, [sortedComments, bead?.id, scrollContainerRef, captureAnchor])

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
