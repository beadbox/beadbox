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
  const [isFirstCommentVisible, setIsFirstCommentVisible] = useState(false)
  const [isLastCommentVisible, setIsLastCommentVisible] = useState(false)
  const [isAtTop, setIsAtTop] = useState(true)
  const beadId = bead?.id
  const commentCount = bead?.comments.length ?? 0
  const previousBeadIdRef = useRef<string | undefined>(undefined)

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
    if (previousBeadIdRef.current === beadId) return
    previousBeadIdRef.current = beadId
    setFocusedCommentIndex(null)
    setIsAtTop(true)
  }, [beadId])

  // Reset focus when panel loses focus
  useEffect(() => {
    if (!isFocused) setFocusedCommentIndex(null)
  }, [isFocused])

  // Track visibility of first and last comments
  useEffect(() => {
    const firstElement = firstCommentRef.current
    const lastElement = lastCommentRef.current
    const container = scrollContainerRef.current
    if (!container || commentCount === 0) {
      setIsFirstCommentVisible(false)
      setIsLastCommentVisible(false)
      return
    }

    const observers: IntersectionObserver[] = []

    if (firstElement) {
      const firstObserver = new IntersectionObserver(
        ([entry]) => setIsFirstCommentVisible(entry.isIntersecting),
        { root: container, threshold: 0.5 },
      )
      firstObserver.observe(firstElement)
      observers.push(firstObserver)
    }

    if (lastElement) {
      const lastObserver = new IntersectionObserver(
        ([entry]) => setIsLastCommentVisible(entry.isIntersecting),
        { root: container, threshold: 0.5 },
      )
      lastObserver.observe(lastElement)
      observers.push(lastObserver)
    }

    return () => {
      for (const observer of observers) observer.disconnect()
    }
  }, [commentCount, scrollContainerRef])

  // Track scroll position
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    if (beadId === undefined) {
      setIsAtTop(true)
      return
    }

    const handleScroll = () => setIsAtTop(container.scrollTop < 50)
    handleScroll()
    container.addEventListener("scroll", handleScroll)
    return () => container.removeEventListener("scroll", handleScroll)
  }, [beadId, scrollContainerRef])

  const scrollToFirstComment = useCallback(() => {
    firstCommentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  const scrollToLastComment = useCallback(() => {
    lastCommentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

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

  const scrollToLatestComment = useCallback(() => {
    if (!bead || sortedComments.length === 0) return
    const lastIndex = sortedComments.length - 1
    setFocusedCommentIndex(lastIndex)
    setTimeout(() => {
      commentRefs.current[lastIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    }, 0)
  }, [bead, sortedComments])

  return {
    sortedComments,
    groupedComments,
    focusedCommentIndex,
    setFocusedCommentIndex,
    isFirstCommentVisible,
    isLastCommentVisible,
    isAtTop,
    scrollToFirstComment,
    scrollToLastComment,
    navigateComments,
    scrollToLatestComment,
    commentRefs,
    firstCommentRef,
    lastCommentRef,
  }
}
