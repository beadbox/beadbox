import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import type { Filters } from "@/components/filter-bar"
import { useHasTrains } from "@/hooks/use-has-trains"
import { dispatchKeyDown, type KeyNavContext } from "@/lib/epic-navigation-keys"
import { countAllBeads, findBeadById, findParentPath } from "@/lib/epic-tree-utils"
import {
  getAnalyticsEnabled,
  getExpandedBeads as getStoredExpandedBeads,
  getExpandedEpics as getStoredExpandedEpics,
  getSelectedBead as getStoredSelectedBead,
  setExpandedBeads as setStoredExpandedBeads,
  setExpandedEpics as setStoredExpandedEpics,
  setSelectedBead as setStoredSelectedBead,
} from "@/lib/local-storage"
import { toastError } from "@/lib/notifications"
import { safeCapture } from "@/lib/posthog-safe"
import { rpc } from "@/lib/rpc"
import type { Bead, Epic, Workspace } from "@/lib/types"

const getBeadDetail = rpc.epics.getBeadDetail

interface UseEpicNavigationOpts {
  epics: Epic[]
  currentWorkspace: Workspace | null
  filters: Filters
  filteredEpics: Epic[]
  vimEnabled: boolean
  isMobileLayout: boolean
  settingsOpen: boolean
  filterBarVisible: boolean
  isTauriRef: React.RefObject<boolean>
  zoomLevel: number
  handleRefresh: () => void
  handleZoomChange: (level: number) => void
  onOpenSettings: () => void
  onToggleFilterBar: (visible: boolean) => void
  onBeadRead: (beadId: string, bead: Bead) => void
  onMarkAllRead: (beads: Bead[]) => void
  updateBeadInEpicsRef: React.RefObject<(beadId: string, fn: (bead: Bead) => Bead) => void>
  activeEpicsFiltered: Epic[]
  activeMilestonesFiltered: Epic[]
  activeConvoysFiltered: Epic[]
  activeMoleculesFiltered: Epic[]
  backlogBeads: Bead[]
  backlogEpics: Epic[]
  archivedBeads: Bead[]
  archivedEpics: Epic[]
  flatBeads: Bead[]
  hasRealEpics: boolean
  treeContainerRef: React.RefObject<HTMLDivElement | null>
}

export function useEpicNavigation(opts: UseEpicNavigationOpts) {
  const {
    epics,
    currentWorkspace,
    filters,
    filteredEpics,
    vimEnabled,
    isMobileLayout,
    settingsOpen,
    filterBarVisible,
    isTauriRef,
    zoomLevel,
    handleRefresh,
    handleZoomChange,
    onOpenSettings,
    onToggleFilterBar,
    onBeadRead,
    onMarkAllRead,
    updateBeadInEpicsRef,
    activeEpicsFiltered,
    activeMilestonesFiltered,
    activeConvoysFiltered,
    activeMoleculesFiltered,
    backlogBeads,
    backlogEpics,
    archivedBeads,
    archivedEpics,
    flatBeads,
    hasRealEpics,
    treeContainerRef,
  } = opts

  // beadbox-if6: Cmd/Ctrl+4 exists only when the workspace has .beadtrain files.
  const hasTrains = useHasTrains(currentWorkspace?.id)
  const hasTrainsRef = useRef(hasTrains)
  hasTrainsRef.current = hasTrains

  const navigate = useNavigate()
  const router = useMemo(
    () => ({
      push: (to: string) => navigate({ to: to as never }),
      back: () => window.history.back(),
    }),
    [navigate],
  )

  // Session-scoped expanded state for epics
  const [expandedEpics, setExpandedEpicsState] = useState<Set<string>>(new Set())

  // Session-scoped expanded beads (subtasks)
  const [expandedBeads, setExpandedBeadsState] = useState<Set<string>>(new Set())

  // Session-scoped bead selection state
  const [beadIdParam, setBeadIdParam] = useState<string | null>(null)

  // Hydrate session state on mount
  useEffect(() => {
    const storedEpics = getStoredExpandedEpics()
    // Default: Loose Beads (_standalone) expanded on fresh session
    setExpandedEpicsState(new Set(storedEpics.length > 0 ? storedEpics : ["_standalone"]))
    setExpandedBeadsState(new Set(getStoredExpandedBeads()))
    setBeadIdParam(getStoredSelectedBead())
  }, [])

  const [selectedBead, setSelectedBead] = useState<Bead | null>(null)
  const getSelectedBead = useEffectEvent(() => selectedBead)
  const updateBeadInEpics = useEffectEvent((bead: Bead) => {
    updateBeadInEpicsRef.current(bead.id, () => bead)
  })
  const [isLoadingBead, setIsLoadingBead] = useState(false)

  // Keyboard navigation focus state (separate from URL-based selection)
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null)

  // Panel focus state for left/right navigation
  const [focusedPanel, setFocusedPanel] = useState<"left" | "right">("left")
  const detailPanelRef = useRef<{
    navigateComments: (direction: "up" | "down") => void
    scrollToLatestComment: () => void
  } | null>(null)

  // Track last key press for multi-key sequences (gg)
  const lastKeyRef = useRef<{ key: string; time: number }>({ key: "", time: 0 })

  // Debounce state for keyboard shortcut analytics
  const lastShortcutRef = useRef<{
    key: string
    count: number
    timer: ReturnType<typeof setTimeout> | null
  }>({ key: "", count: 0, timer: null })

  // Track which bead we've already loaded to avoid re-fetching on epics refresh
  const loadedBeadIdRef = useRef<string | null>(null)

  // Fetch full bead details (including comments) when bead selection changes
  useEffect(() => {
    if (!beadIdParam || epics.length === 0) {
      setSelectedBead(null)
      loadedBeadIdRef.current = null
      return
    }

    // First check if bead exists in cached data
    const cachedBead = findBeadById(epics, beadIdParam)
    if (!cachedBead) {
      setSelectedBead(null)
      loadedBeadIdRef.current = null
      return
    }

    // Only do full fetch if this is a new bead selection
    if (loadedBeadIdRef.current === beadIdParam) {
      // Sync status/priority/title immediately from cached epics data
      setSelectedBead((prev) =>
        prev
          ? {
              ...prev,
              status: cachedBead.status,
              priority: cachedBead.priority,
              title: cachedBead.title,
            }
          : cachedBead,
      )
      // Skip background refetch if selectedBead already has comments populated
      // from a previous getBeadDetail call AND commentCount hasn't changed.
      // The server-side cache will also short-circuit, but this avoids the round-trip entirely.
      const currentBead = getSelectedBead()
      if (
        currentBead &&
        currentBead.id === beadIdParam &&
        currentBead.comments.length > 0 &&
        currentBead.commentCount === cachedBead.commentCount
      ) {
        return
      }
      // Data may have changed (new comments, etc.) - refetch
      getBeadDetail(beadIdParam, currentWorkspace?.id)
        .then((fullBead) => {
          if (!fullBead) return
          setSelectedBead((prev) => {
            if (!prev || prev.id !== beadIdParam) return prev
            if (fullBead.comments.length > prev.comments.length) {
              setTimeout(() => detailPanelRef.current?.scrollToLatestComment(), 50)
            }
            return { ...prev, ...fullBead }
          })
        })
        .catch(() => toastError("Failed to load issue details"))
      return
    }

    // New bead - show cached data immediately, then fetch full details with comments
    loadedBeadIdRef.current = beadIdParam
    setSelectedBead(cachedBead)
    setIsLoadingBead(true)

    getBeadDetail(beadIdParam, currentWorkspace?.id)
      .then((fullBead) => {
        if (fullBead) {
          setSelectedBead(fullBead)
          // If data changed externally, update the bead in epics without full reload
          const hasChanges =
            fullBead.status !== cachedBead.status ||
            fullBead.priority !== cachedBead.priority ||
            fullBead.title !== cachedBead.title
          if (hasChanges) {
            updateBeadInEpics(fullBead)
          }
        }
      })
      .catch(() => toastError("Failed to load issue details"))
      .finally(() => {
        setIsLoadingBead(false)
      })
  }, [beadIdParam, epics, currentWorkspace?.id])

  const parentPath = useMemo(() => {
    if (!beadIdParam) return []
    return findParentPath(epics, beadIdParam) || []
  }, [beadIdParam, epics])

  const handleToggleEpic = useCallback((epicId: string) => {
    setExpandedEpicsState((prev) => {
      const next = new Set(prev)
      if (next.has(epicId)) {
        next.delete(epicId)
      } else {
        next.add(epicId)
        if (getAnalyticsEnabled()) {
          safeCapture("app_epic_expanded")
        }
      }
      setStoredExpandedEpics(Array.from(next))
      return next
    })
  }, [])

  const handleSetExpandedEpics = useCallback((epicIds: string[]) => {
    setExpandedEpicsState(new Set(epicIds))
    setStoredExpandedEpics(epicIds)
  }, [])

  const handleToggleBead = useCallback((beadId: string) => {
    setExpandedBeadsState((prev) => {
      const next = new Set(prev)
      if (next.has(beadId)) {
        next.delete(beadId)
      } else {
        next.add(beadId)
      }
      setStoredExpandedBeads(Array.from(next))
      return next
    })
  }, [])

  // Computed flat list of navigable items (respects expand/collapse state)
  // Includes bead reference and builds id->index map to avoid O(n) lookups on each keypress
  const { navigableItems, itemIndexMap } = useMemo(() => {
    const items: { id: string; type: "epic" | "bead"; bead: Bead }[] = []
    const indexMap = new Map<string, number>()

    function addBead(bead: Bead) {
      indexMap.set(bead.id, items.length)
      items.push({ id: bead.id, type: "bead", bead })
      if (expandedBeads.has(bead.id) && bead.children) {
        bead.children.forEach(addBead)
      }
    }

    function addEpic(epic: Epic) {
      indexMap.set(epic.id, items.length)
      items.push({ id: epic.id, type: "epic", bead: epic })
      if (expandedEpics.has(epic.id)) {
        epic.childEpics?.forEach(addEpic)
        epic.children?.forEach(addBead)
      }
    }

    // In flat mode (no real epics), add beads directly; otherwise use epic hierarchy
    if (!hasRealEpics && flatBeads.length > 0) {
      flatBeads.forEach(addBead)
    } else {
      activeMilestonesFiltered.forEach(addEpic)
      activeEpicsFiltered.forEach(addEpic)
      activeMoleculesFiltered.forEach(addEpic)
      activeConvoysFiltered.forEach(addEpic)
    }
    // Add backlog beads
    backlogBeads.forEach(addBead)
    backlogEpics.forEach(addEpic)
    // Add archived beads and epics
    archivedBeads.forEach(addBead)
    archivedEpics.forEach(addEpic)
    return { navigableItems: items, itemIndexMap: indexMap }
  }, [
    hasRealEpics,
    flatBeads,
    activeEpicsFiltered,
    activeMilestonesFiltered,
    activeMoleculesFiltered,
    activeConvoysFiltered,
    backlogBeads,
    backlogEpics,
    archivedBeads,
    archivedEpics,
    expandedEpics,
    expandedBeads,
  ])

  // Browser back button support for mobile stacked layout
  // Push a history entry when selecting a bead on mobile, pop to close
  const mobileHistoryPushedRef = useRef(false)

  useEffect(() => {
    if (!isMobileLayout) return

    const handlePopState = (e: PopStateEvent) => {
      if (e.state?.mobileDetail) {
        // Going back from a deeper detail push (shouldn't happen, but handle gracefully)
        return
      }
      // User pressed back: close detail view
      if (mobileHistoryPushedRef.current) {
        mobileHistoryPushedRef.current = false
        setBeadIdParam(null)
        setStoredSelectedBead(null)
      }
    }

    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [isMobileLayout])

  const handleBeadClick = useCallback(
    (bead: Bead) => {
      if (getAnalyticsEnabled()) {
        safeCapture("app_issue_opened", {
          issue_type: bead.type,
          issue_status: bead.status,
        })
        if (filters.search) {
          safeCapture("app_search_used", {
            query_length: filters.search.length,
            result_count: countAllBeads(filteredEpics),
            selected: true,
          })
        }
      }
      if (isMobileLayout) {
        window.history.pushState({ mobileDetail: true }, "")
        mobileHistoryPushedRef.current = true
      }
      setBeadIdParam(bead.id)
      setStoredSelectedBead(bead.id)
      // Mark bead as read
      onBeadRead(bead.id, bead)
    },
    [isMobileLayout, filters.search, filteredEpics, onBeadRead],
  )

  const handleBeadNavigate = useCallback(
    (beadId: string) => {
      // On mobile, if we don't already have a history entry pushed, push one
      if (isMobileLayout && !mobileHistoryPushedRef.current) {
        window.history.pushState({ mobileDetail: true }, "")
        mobileHistoryPushedRef.current = true
      }
      setBeadIdParam(beadId)
      setStoredSelectedBead(beadId)
      // Mark bead as read (find bead from navigable items)
      const item = navigableItems.find((ni) => ni.id === beadId)
      if (item?.bead) {
        onBeadRead(beadId, item.bead)
      }
    },
    [isMobileLayout, navigableItems, onBeadRead],
  )

  const handleCloseDetail = useCallback(() => {
    if (selectedBead && getAnalyticsEnabled()) {
      safeCapture("app_detail_panel_action", {
        action: "close_panel",
        issue_type: selectedBead.type,
      })
    }
    // Clear activity feed navigation flag since user is staying on beads page
    sessionStorage.removeItem("beadbox-nav-from-activity")
    // If we pushed a history entry for mobile detail, pop it via history.back().
    // The popstate handler will see mobileHistoryPushedRef is still true,
    // clear it, and call setBeadIdParam(null).
    if (isMobileLayout && mobileHistoryPushedRef.current) {
      window.history.back()
      return
    }
    setBeadIdParam(null)
    setStoredSelectedBead(null)
  }, [isMobileLayout, selectedBead])

  // Clean up shortcut debounce timer on unmount
  useEffect(() => {
    const ref = lastShortcutRef.current
    return () => {
      if (ref.timer) clearTimeout(ref.timer)
    }
  }, [])

  // Fire keyboard shortcut analytics event, debouncing rapid j/k navigation
  const captureShortcut = useCallback(
    (shortcut: string, context: "tree" | "detail" | "global") => {
      if (!getAnalyticsEnabled()) return
      const ref = lastShortcutRef.current

      // Debounce rapid j/k/arrow navigation into a single event with repeat_count
      const isNavKey = shortcut === "j" || shortcut === "k"
      if (isNavKey && ref.key === shortcut) {
        ref.count++
        if (ref.timer) clearTimeout(ref.timer)
        ref.timer = setTimeout(() => {
          safeCapture("app_keyboard_shortcut_used", {
            shortcut,
            context,
            vim_mode_enabled: vimEnabled,
            repeat_count: ref.count,
          })
          ref.count = 0
          ref.key = ""
          ref.timer = null
        }, 500)
        return
      }

      // Flush any pending debounced event before capturing a new one
      if (ref.timer) {
        clearTimeout(ref.timer)
        safeCapture("app_keyboard_shortcut_used", {
          shortcut: ref.key,
          context,
          vim_mode_enabled: vimEnabled,
          repeat_count: ref.count,
        })
        ref.timer = null
      }

      if (isNavKey) {
        // Start new debounce window for nav keys
        ref.key = shortcut
        ref.count = 1
        ref.timer = setTimeout(() => {
          safeCapture("app_keyboard_shortcut_used", {
            shortcut,
            context,
            vim_mode_enabled: vimEnabled,
            repeat_count: ref.count,
          })
          ref.count = 0
          ref.key = ""
          ref.timer = null
        }, 500)
      } else {
        // Non-nav keys fire immediately
        ref.key = ""
        ref.count = 0
        safeCapture("app_keyboard_shortcut_used", {
          shortcut,
          context,
          vim_mode_enabled: vimEnabled,
          repeat_count: 1,
        })
      }
    },
    [vimEnabled],
  )

  // Keyboard navigation handler. Body lifted to lib/epic-navigation-keys.ts
  // (bb-fe03.3 — was 309 NLOC at CCN 112). The hook now just builds the
  // KeyNavContext from current closure state and dispatches.
  const isTauri = !!isTauriRef.current
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const ctx: KeyNavContext = {
        focusedItemId,
        navigableItems,
        itemIndexMap,
        expandedEpics,
        expandedBeads,
        beadIdParam,
        selectedBead,
        focusedPanel,
        settingsOpen,
        filterBarVisible,
        vimEnabled,
        zoomLevel,
        isTauri,
        hasTrains: hasTrainsRef.current,
        setFocusedItemId,
        setFocusedPanel,
        handleToggleEpic,
        handleToggleBead,
        handleBeadClick,
        handleCloseDetail,
        handleRefresh,
        handleZoomChange,
        onOpenSettings,
        onToggleFilterBar,
        onMarkAllRead,
        router,
        detailNavigateComments: detailPanelRef.current?.navigateComments.bind(
          detailPanelRef.current,
        ),
        captureShortcut,
        lastKey: lastKeyRef.current,
        setLastKey: (next) => {
          lastKeyRef.current = next
        },
      }
      dispatchKeyDown(e, ctx)
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    focusedItemId,
    navigableItems,
    itemIndexMap,
    expandedEpics,
    expandedBeads,
    beadIdParam,
    selectedBead,
    focusedPanel,
    settingsOpen,
    vimEnabled,
    handleToggleEpic,
    handleToggleBead,
    handleBeadClick,
    handleCloseDetail,
    handleRefresh,
    handleZoomChange,
    router,
    filterBarVisible,
    onToggleFilterBar,
    onMarkAllRead,
    onOpenSettings,
    zoomLevel,
    isTauri,
    captureShortcut,
  ])

  // Listen for Tauri-dispatched refresh events (Linux: GTK intercepts Ctrl+R
  // before JS keydown fires, so Rust sends a custom DOM event instead)
  useEffect(() => {
    const handleTauriRefresh = () => handleRefresh()
    document.addEventListener("tauri-refresh", handleTauriRefresh)
    return () => document.removeEventListener("tauri-refresh", handleTauriRefresh)
  }, [handleRefresh])

  // Scroll focused item into view
  const scrollFocusedItemIntoView = useEffectEvent((itemId: string) => {
    const container = treeContainerRef.current
    if (container) {
      const element = container.querySelector(`[data-item-id="${itemId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }
  })
  useEffect(() => {
    if (focusedItemId) scrollFocusedItemIntoView(focusedItemId)
  }, [focusedItemId])

  return {
    expandedEpics,
    expandedBeads,
    beadIdParam,
    selectedBead,
    setSelectedBead,
    isLoadingBead,
    focusedItemId,
    setFocusedItemId,
    focusedPanel,
    setFocusedPanel,
    detailPanelRef,
    parentPath,
    navigableItems,
    itemIndexMap,
    handleToggleEpic,
    handleSetExpandedEpics,
    handleToggleBead,
    handleBeadClick,
    handleBeadNavigate,
    handleCloseDetail,
  }
}
