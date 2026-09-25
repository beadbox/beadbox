import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Filter,
  Layers,
  RefreshCw,
  Search,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type BulkGroup,
  type FeedItem,
  type FlatNavItem,
  getBulkGroupSummary,
  groupBulkOperations,
} from "../lib/activity-bulk-operations"
import {
  ALL_EVENT_TYPES,
  countActiveFilters,
  EVENT_TYPE_LABELS,
  getTimeCutoff,
  hasActiveFilters,
  matchesFilters,
  TIME_RANGE_OPTIONS,
} from "../lib/activity-filters"
import { eventKey, extractActorFromMessage, extractBeadTitle } from "../lib/activity-message-utils"
import {
  type ActivityFilters,
  DEFAULT_FILTERS,
  loadAndClearScrollPosition,
  loadFilters,
  saveFilters,
  saveScrollPosition,
} from "../lib/activity-storage"
import { formatAbsoluteTime, getTimePeriod, isToday, isYesterday } from "../lib/activity-time-utils"
import { formatRelativeTime } from "../lib/activity-utils"
import { rpc } from "../lib/rpc"
import type { ActivityEvent, CrossFilter } from "../lib/types"
import { cn } from "../lib/utils"
import { sessionActivityEvents } from "../lib/workspace-session-cache"
import { EventIcon, getActionSummary, getCompactAction } from "./activity-feed-renderers"
import { Checkbox } from "./ui/checkbox"
import { Input } from "./ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select"
import { Skeleton } from "./ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

// getActionSummary is referenced indirectly via a feature-flagged code path
// in the legacy source; keep the import to maintain parity with the original
// component's module surface.
void getActionSummary

// Re-export for backward compatibility (tests import from this module)
export {
  type ActivityFilters,
  type BulkGroup,
  countActiveFilters,
  DEFAULT_FILTERS,
  eventKey,
  extractActorFromMessage,
  extractBeadTitle,
  type FeedItem,
  formatAbsoluteTime,
  getBulkGroupSummary,
  getTimeCutoff,
  getTimePeriod,
  groupBulkOperations,
  hasActiveFilters,
  isToday,
  isYesterday,
  loadFilters,
  matchesFilters,
  saveFilters,
}

interface ActivityFeedProps {
  dbPath?: string
  /**
   * Workspace the dbPath belongs to. Keys the session cache that lets the
   * feed paint its last events instead of the loading placeholder when this
   * route is re-entered (the router unmounts it on every navigation away).
   */
  workspaceId?: string
  changeSignal?: number
  /** Called when user clicks/presses Enter on a feed item. Returns false if bead was deleted. */
  onBeadNavigate?: (beadId: string) => Promise<boolean>
  /** Cross-filter from agent strip / pipeline. When active, feed shows only matching events. */
  crossFilter?: CrossFilter
  /** Fires whenever the internal events array changes, so the parent can derive agent/pipeline state. */
  onEventsChange?: (events: ActivityEvent[]) => void
  /** Map of bead ID -> current status. Used to resolve stage cross-filter (which beads are in which stage). */
  beadStatusMap?: Map<string, string>
  /** Called when the user clears filters and a cross-filter is active. Allows the parent to clear its cross-filter state. */
  onClearCrossFilter?: () => void
}

export function ActivityFeed({
  dbPath,
  workspaceId,
  changeSignal = 0,
  onBeadNavigate,
  crossFilter,
  onEventsChange,
  beadStatusMap,
  onClearCrossFilter,
}: ActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>(
    () => sessionActivityEvents.get(workspaceId) ?? [],
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [pendingEvents, setPendingEvents] = useState<ActivityEvent[]>([])
  const [isAtTop, setIsAtTop] = useState(true)
  void isAtTop
  const isAtTopRef = useRef(true)
  const feedRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const lastGPress = useRef<number>(0)
  const fetchInProgressRef = useRef(false)
  const debouncedFetchRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialLoadDoneRef = useRef(false)
  const prevChangeSignalRef = useRef(changeSignal)
  const seenKeysRef = useRef<Set<string>>(new Set())

  // Track deleted bead IDs (shown inline notice instead of navigating)
  const [deletedBeadIds, setDeletedBeadIds] = useState<Set<string>>(new Set())

  // Filter state (persisted in sessionStorage)
  const [filters, setFilters] = useState<ActivityFilters>(DEFAULT_FILTERS)
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const filterPanelRef = useRef<HTMLDivElement>(null)
  const beadSearchRef = useRef<HTMLInputElement>(null)

  // Load persisted filters on mount
  useEffect(() => {
    setFilters(loadFilters())
  }, [])

  // The rail can switch workspace without remounting this route: swap in the
  // new workspace's cached events (or clear, so the previous project's
  // activity is never shown under the new project's name) while its load runs.
  const seededWorkspaceRef = useRef(workspaceId)
  useEffect(() => {
    if (seededWorkspaceRef.current === workspaceId) return
    seededWorkspaceRef.current = workspaceId
    setEvents(sessionActivityEvents.get(workspaceId) ?? [])
  }, [workspaceId])

  // Mirror the rendered events so the next visit paints from them. Guarded by
  // the workspace they were loaded for, since `events` and `workspaceId` can
  // change on different commits.
  useEffect(() => {
    if (seededWorkspaceRef.current !== workspaceId || events.length === 0) return
    sessionActivityEvents.set(workspaceId, events)
  }, [events, workspaceId])

  // Persist filters on change (skip the initial default state)
  const filtersInitialized = useRef(false)
  useEffect(() => {
    if (!filtersInitialized.current) {
      filtersInitialized.current = true
      return
    }
    saveFilters(filters)
  }, [filters])

  const updateFilters = useCallback((update: Partial<ActivityFilters>) => {
    setFilters((prev) => ({ ...prev, ...update }))
  }, [])

  const clearAllFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS)
    onClearCrossFilter?.()
  }, [onClearCrossFilter])

  // Extract unique actors from all events
  const availableActors = useMemo(() => {
    const actorSet = new Set<string>()
    for (const event of events) {
      const actor = extractActorFromMessage(event)
      if (actor) actorSet.add(actor)
    }
    return Array.from(actorSet).sort()
  }, [events])

  // Rebuild seen keys set whenever events change (for deduplication)
  useEffect(() => {
    if (events.length > 0) {
      const keys = new Set<string>()
      for (const e of events) {
        keys.add(eventKey(e))
      }
      seenKeysRef.current = keys
    }
  }, [events])

  // Notify parent when events change (for agent strip / pipeline derivation)
  useEffect(() => {
    onEventsChange?.(events)
  }, [events, onEventsChange])

  const loadEvents = useCallback(
    async (limit: number = 100) => {
      if (!dbPath) return
      setLoading(true)
      setError(null)
      const result = await rpc.activity.getActivityEvents(workspaceId ?? dbPath, limit)
      if (result.error) {
        setError(result.error)
      } else {
        setEvents(result.events)
        setHasMore(result.events.length >= limit)
      }
      setLoading(false)
      initialLoadDoneRef.current = true
    },
    [dbPath, workspaceId],
  )

  const loadMore = useCallback(async () => {
    if (!dbPath || loadingMore || !hasMore) return
    setLoadingMore(true)
    const newLimit = events.length + 100
    const result = await rpc.activity.getActivityEvents(workspaceId ?? dbPath, newLimit)
    if (!result.error) {
      setEvents(result.events)
      setHasMore(result.events.length >= newLimit)
    }
    setLoadingMore(false)
  }, [dbPath, workspaceId, events.length, loadingMore, hasMore])

  // Fetch new events using a 2-minute window (bd --since expects duration, not timestamp)
  const fetchNewEvents = useCallback(async () => {
    if (!dbPath || !initialLoadDoneRef.current || fetchInProgressRef.current) return
    fetchInProgressRef.current = true
    try {
      const result = await rpc.activity.getActivityEventsSince(workspaceId ?? dbPath, "2m")
      if (result.error || result.events.length === 0) {
        fetchInProgressRef.current = false
        return
      }

      // Deduplicate against existing events and pending events
      const existingKeys = seenKeysRef.current
      const newEvents = result.events.filter((e) => !existingKeys.has(eventKey(e)))

      if (newEvents.length === 0) {
        fetchInProgressRef.current = false
        return
      }

      if (isAtTopRef.current) {
        // User is at top: prepend new events (newest-first order)
        setEvents((prev) => {
          const prevKeys = new Set(prev.map(eventKey))
          const deduped = newEvents.filter((e) => !prevKeys.has(eventKey(e)))
          return deduped.length > 0 ? [...deduped, ...prev] : prev
        })
      } else {
        // User is scrolled down: buffer new events (dedup against existing pending)
        setPendingEvents((prev) => {
          const prevKeys = new Set(prev.map(eventKey))
          const deduped = newEvents.filter((e) => !prevKeys.has(eventKey(e)))
          return deduped.length > 0 ? [...prev, ...deduped] : prev
        })
      }
    } finally {
      fetchInProgressRef.current = false
    }
  }, [dbPath, workspaceId])

  // Initial load
  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  // Restore scroll position after initial load (back-navigation from bead detail)
  useEffect(() => {
    if (loading || events.length === 0) return
    const savedScroll = loadAndClearScrollPosition()
    if (savedScroll !== null && feedRef.current) {
      requestAnimationFrame(() => {
        if (feedRef.current) {
          feedRef.current.scrollTop = savedScroll
        }
      })
    }
    // loadAndClearScrollPosition consumes the saved value on the first successful load.
  }, [loading, events.length])

  // React to changeSignal (WebSocket change events) with debounce
  useEffect(() => {
    // Skip on initial mount (prevChangeSignalRef starts equal to changeSignal)
    if (changeSignal === prevChangeSignalRef.current) return
    prevChangeSignalRef.current = changeSignal

    if (!initialLoadDoneRef.current) return

    // Debounce: coalesce rapid WS signals into one fetch (500ms)
    if (debouncedFetchRef.current) {
      clearTimeout(debouncedFetchRef.current)
    }
    debouncedFetchRef.current = setTimeout(() => {
      fetchNewEvents()
    }, 500)

    return () => {
      if (debouncedFetchRef.current) {
        clearTimeout(debouncedFetchRef.current)
      }
    }
  }, [changeSignal, fetchNewEvents])

  // Flush pending events when user scrolls back to top
  const flushPendingEvents = useCallback(() => {
    if (pendingEvents.length === 0) return
    setEvents((prev) => {
      const existingKeys = new Set(prev.map(eventKey))
      const deduped = pendingEvents.filter((e) => !existingKeys.has(eventKey(e)))
      return [...deduped, ...prev]
    })
    setPendingEvents([])
    feedRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }, [pendingEvents])

  // Scroll position tracking
  useEffect(() => {
    const container = feedRef.current
    if (!container) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      // At top if within 10px of top
      const atTop = scrollTop <= 10
      setIsAtTop(atTop)
      isAtTopRef.current = atTop

      // Progressive loading: load more when near bottom
      if (scrollHeight - scrollTop - clientHeight < 200 && hasMore && !loadingMore) {
        loadMore()
      }
    }

    container.addEventListener("scroll", handleScroll, { passive: true })
    return () => container.removeEventListener("scroll", handleScroll)
  }, [hasMore, loadingMore, loadMore])

  // Filter events, then group by time period (events are already newest-first)
  // Cross-filter from dashboard layers is applied as an additional predicate on top of ActivityFilters.
  const filteredEvents = useMemo(() => {
    const hasCrossFilter = crossFilter && crossFilter.type !== null
    const hasLocalFilters = hasActiveFilters(filters)
    if (!hasLocalFilters && !hasCrossFilter) return events

    return events.filter((e) => {
      // Existing activity filters
      if (hasLocalFilters && !matchesFilters(e, filters, extractActorFromMessage)) return false
      // Cross-filter predicate
      if (hasCrossFilter) {
        switch (crossFilter.type) {
          case "agent":
            if (extractActorFromMessage(e) !== crossFilter.value) return false
            break
          case "stage":
            if (beadStatusMap) {
              const beadStatus = beadStatusMap.get(e.issue_id)
              if (beadStatus !== crossFilter.value) return false
            }
            break
          case "bead":
            if (e.issue_id !== crossFilter.value) return false
            break
        }
      }
      return true
    })
  }, [events, filters, crossFilter, beadStatusMap])

  const groupedEvents = useMemo(() => {
    // bd list --sort updated returns newest-first (descending by updated_at)
    // Live updates are prepended, so filteredEvents is already newest-first
    const groups: { period: string; items: FeedItem[] }[] = []
    let currentPeriod: string | null = null
    let currentEvents: ActivityEvent[] = []

    const flushPeriod = () => {
      if (currentPeriod !== null && currentEvents.length > 0) {
        groups.push({ period: currentPeriod, items: groupBulkOperations(currentEvents) })
      }
    }

    for (const event of filteredEvents) {
      const period = getTimePeriod(event.timestamp)
      if (period !== currentPeriod) {
        flushPeriod()
        currentPeriod = period
        currentEvents = [event]
      } else {
        currentEvents.push(event)
      }
    }
    flushPeriod()

    return groups
  }, [filteredEvents])

  // Toggle expand/collapse for a bulk group
  const toggleGroup = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) {
        next.delete(groupKey)
      } else {
        next.add(groupKey)
      }
      return next
    })
  }, [])

  // Flat list of navigable items (accounts for expanded bulk groups)
  const flatNavItems = useMemo(() => {
    const items: FlatNavItem[] = []
    for (const group of groupedEvents) {
      for (const item of group.items) {
        if (item.type === "single") {
          items.push({ type: "single", event: item.event })
        } else {
          items.push({ type: "bulk-header", group: item })
          if (expandedGroups.has(item.groupKey)) {
            for (const subEvent of item.events) {
              items.push({ type: "bulk-sub", event: subEvent, group: item })
            }
          }
        }
      }
    }
    return items
  }, [groupedEvents, expandedGroups])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return
      }

      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault()
          setFocusedIndex((prev) => {
            const next = Math.min(prev + 1, flatNavItems.length - 1)
            itemRefs.current.get(next)?.scrollIntoView({ block: "nearest" })
            return next
          })
          break
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault()
          setFocusedIndex((prev) => {
            const next = Math.max(prev - 1, 0)
            itemRefs.current.get(next)?.scrollIntoView({ block: "nearest" })
            return next
          })
          break
        }
        case "Enter": {
          if (focusedIndex >= 0 && focusedIndex < flatNavItems.length) {
            const item = flatNavItems[focusedIndex]
            if (item.type === "bulk-header") {
              // Toggle expand/collapse on bulk group headers
              e.preventDefault()
              toggleGroup(item.group.groupKey)
            } else if (item.type === "single" || item.type === "bulk-sub") {
              // Navigate to bead detail for single events and sub-items
              if (onBeadNavigate && !deletedBeadIds.has(item.event.issue_id)) {
                e.preventDefault()
                if (feedRef.current) saveScrollPosition(feedRef.current.scrollTop)
                onBeadNavigate(item.event.issue_id).then((exists) => {
                  if (!exists) {
                    setDeletedBeadIds((prev) => new Set(prev).add(item.event.issue_id))
                  }
                })
              }
            }
          }
          break
        }
        case "g": {
          const now = Date.now()
          if (now - lastGPress.current < 500) {
            // gg: jump to top (use instant to avoid re-render cancellation)
            e.preventDefault()
            setFocusedIndex(0)
            requestAnimationFrame(() => {
              feedRef.current?.scrollTo({ top: 0, behavior: "instant" })
            })
          } else {
            lastGPress.current = now
          }
          break
        }
        case "G": {
          // G: jump to bottom (use instant to avoid re-render cancellation)
          e.preventDefault()
          const last = flatNavItems.length - 1
          setFocusedIndex(last)
          requestAnimationFrame(() => {
            itemRefs.current.get(last)?.scrollIntoView({ block: "end", behavior: "instant" })
          })
          break
        }
        case "f": {
          // Toggle filter panel
          if (!filterPanelOpen) {
            e.preventDefault()
            setFilterPanelOpen(true)
            // Focus the bead search input after panel opens
            requestAnimationFrame(() => {
              beadSearchRef.current?.focus()
            })
          }
          break
        }
        case "Escape": {
          if (filterPanelOpen) {
            e.preventDefault()
            setFilterPanelOpen(false)
          }
          break
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [flatNavItems, focusedIndex, filterPanelOpen, toggleGroup, onBeadNavigate, deletedBeadIds])

  // Build filter chip descriptors
  const filterChips = useMemo(() => {
    const chips: { key: string; label: string; onRemove: () => void }[] = []

    if (filters.actors.length > 0) {
      chips.push({
        key: "actors",
        label: `Actor: ${filters.actors.join(", ")}`,
        onRemove: () => updateFilters({ actors: [] }),
      })
    }
    if (filters.beadSearch) {
      chips.push({
        key: "bead",
        label: `Bead: ${filters.beadSearch}`,
        onRemove: () => updateFilters({ beadSearch: "" }),
      })
    }
    if (filters.eventTypes.length > 0) {
      const labels = filters.eventTypes.map((t) => EVENT_TYPE_LABELS[t] || t)
      chips.push({
        key: "types",
        label: `Type: ${labels.join(", ")}`,
        onRemove: () => updateFilters({ eventTypes: [] }),
      })
    }
    if (filters.timeRange !== "all") {
      const opt = TIME_RANGE_OPTIONS.find((o) => o.value === filters.timeRange)
      chips.push({
        key: "time",
        label: opt?.label || filters.timeRange,
        onRemove: () => updateFilters({ timeRange: "all" }),
      })
    }

    return chips
  }, [filters, updateFilters])

  const activeFilterCount = countActiveFilters(filters)

  // Error state
  if (error && events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <AlertTriangle className="h-8 w-8 text-amber-400 mb-3" />
        <p className="text-sm font-medium text-foreground mb-1">Could not load recent activity</p>
        <p className="text-xs text-muted-foreground mb-4 max-w-sm">{error}</p>
        <button
          onClick={() => loadEvents()}
          className={cn(
            "inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            "transition-colors",
          )}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    )
  }

  // Loading state
  if (loading && events.length === 0) {
    return (
      <div className="space-y-0">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 py-2 px-4 border-b border-border/20">
            <Skeleton className="h-5 w-5 rounded shrink-0" />
            <Skeleton className="h-4 flex-1 max-w-[220px]" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-14 shrink-0" />
          </div>
        ))}
      </div>
    )
  }

  // Empty state (no events at all)
  if (!loading && events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="h-12 w-12 rounded-full bg-muted/50 flex items-center justify-center mb-4">
          <CheckCircle2 className="h-6 w-6 text-muted-foreground/50" />
        </div>
        <p className="text-sm font-medium text-foreground mb-1">No activity yet</p>
        <p className="text-xs text-muted-foreground">
          Changes to beads will appear here as they happen.
        </p>
      </div>
    )
  }

  // Track which flat nav index we're at for keyboard focus
  let navIndex = -1

  // Helper to render a single event row
  const renderEventRow = (event: ActivityEvent, idx: number, indented?: boolean) => {
    const isFocused = idx === focusedIndex
    const beadTitle = extractBeadTitle(event)
    const isDeleted = deletedBeadIds.has(event.issue_id)
    const isNavigable = !!onBeadNavigate && !isDeleted

    return (
      <div
        key={`${event.timestamp}-${event.issue_id}-${event.type}-${idx}`}
        ref={(el) => {
          if (el) {
            itemRefs.current.set(idx, el)
          } else {
            itemRefs.current.delete(idx)
          }
        }}
        className={cn(
          "group flex items-center gap-3 py-2 border-b border-border/20 transition-colors",
          indented ? "pl-10 pr-4" : "px-4",
          isFocused && "bg-accent/50 ring-1 ring-accent ring-inset",
          isNavigable && "cursor-pointer hover:bg-accent/30",
        )}
        onClick={() => {
          setFocusedIndex(idx)
          if (onBeadNavigate && !deletedBeadIds.has(event.issue_id)) {
            if (feedRef.current) saveScrollPosition(feedRef.current.scrollTop)
            onBeadNavigate(event.issue_id).then((exists) => {
              if (!exists) {
                setDeletedBeadIds((prev) => new Set(prev).add(event.issue_id))
              }
            })
          }
        }}
        role={isNavigable ? "button" : undefined}
        tabIndex={isNavigable ? 0 : undefined}
      >
        {/* Event icon */}
        <div className="mt-0.5 shrink-0">
          <EventIcon event={event} />
        </div>

        {/* Single-row: title first, then (actor action) */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {beadTitle ? (
            <span
              className={cn(
                "text-sm truncate",
                isNavigable
                  ? "text-blue-400/80 group-hover:text-blue-400 group-hover:underline"
                  : "text-foreground",
              )}
            >
              {beadTitle}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground truncate">{event.issue_id}</span>
          )}
          <span className="text-xs text-muted-foreground/60 shrink-0 whitespace-nowrap">
            ({extractActorFromMessage(event)} {getCompactAction(event)})
          </span>
          {isDeleted && <span className="text-xs text-amber-400/80 shrink-0">(deleted)</span>}
        </div>

        {/* Timestamp */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground/60 shrink-0 tabular-nums whitespace-nowrap">
              {formatRelativeTime(event.timestamp)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">{formatAbsoluteTime(event.timestamp)}</TooltipContent>
        </Tooltip>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* bb-pgb0.1: deleted the wsConnected Live/Paused/Connecting
          indicator triplet — pm/systemdesign.md §3.3 explicitly declines
          authorization for a "live connection indicator" surface in
          v0.25. The kkrpc subscription wire is implicit; if it breaks,
          the entire app loses RPC, not just live updates. */}
      <div className="flex items-center justify-end px-4 py-1.5 border-b border-border/30">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground/50 tabular-nums">
            {hasActiveFilters(filters)
              ? `${filteredEvents.length} of ${events.length} events`
              : `${events.length} events`}
          </span>
          <button
            onClick={() => {
              setFilterPanelOpen((prev) => !prev)
              if (!filterPanelOpen) {
                requestAnimationFrame(() => beadSearchRef.current?.focus())
              }
            }}
            className={cn(
              "relative inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors",
              filterPanelOpen
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
            title="Toggle filters (f)"
          >
            <Filter className="h-3 w-3" />
            <span className="hidden sm:inline">Filter</span>
            {activeFilterCount > 0 && !filterPanelOpen && (
              <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-500 text-white text-[9px] font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Filter panel */}
      {filterPanelOpen && (
        <div
          ref={filterPanelRef}
          className="border-b border-border/30 bg-muted/20 px-4 py-3 space-y-3"
        >
          {/* Row 1: Bead search + Actor dropdown */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                ref={beadSearchRef}
                placeholder="Search by bead ID or title..."
                value={filters.beadSearch}
                onChange={(e) => updateFilters({ beadSearch: e.target.value })}
                className="pl-8 h-8 text-sm bg-background/50"
              />
            </div>

            <Select
              value={filters.actors.length === 1 ? filters.actors[0] : "all"}
              onValueChange={(value) => {
                if (value === "all") {
                  updateFilters({ actors: [] })
                } else {
                  updateFilters({ actors: [value] })
                }
              }}
            >
              <SelectTrigger className="w-[160px] h-8 text-sm bg-background/50">
                <SelectValue placeholder="All actors" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actors</SelectItem>
                {availableActors.map((actor) => (
                  <SelectItem key={actor} value={actor}>
                    {actor}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={filters.timeRange}
              onValueChange={(value) => updateFilters({ timeRange: value })}
            >
              <SelectTrigger className="w-[140px] h-8 text-sm bg-background/50">
                <Clock className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_RANGE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Row 2: Event type checkboxes */}
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-xs text-muted-foreground font-medium">Types:</span>
            {ALL_EVENT_TYPES.map((type) => {
              const checked = filters.eventTypes.includes(type)
              return (
                <label key={type} className="flex items-center gap-1.5 cursor-pointer text-xs">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(val) => {
                      if (val) {
                        updateFilters({ eventTypes: [...filters.eventTypes, type] })
                      } else {
                        updateFilters({
                          eventTypes: filters.eventTypes.filter((t) => t !== type),
                        })
                      }
                    }}
                    className="h-3.5 w-3.5"
                  />
                  <span
                    className={cn(
                      "select-none",
                      checked ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {EVENT_TYPE_LABELS[type]}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {filterChips.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-border/30 flex-wrap">
          {filterChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 text-[11px] font-medium"
            >
              {chip.label}
              <button
                onClick={chip.onRemove}
                className="hover:text-blue-200 transition-colors"
                aria-label={`Remove ${chip.label} filter`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            onClick={clearAllFilters}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors ml-1"
          >
            Clear all
          </button>
        </div>
      )}

      {/* "N new events" indicator */}
      {pendingEvents.length > 0 && (
        <button
          onClick={flushPendingEvents}
          className={cn(
            "sticky top-0 z-20 w-full flex items-center justify-center gap-2",
            "bg-blue-500/15 text-blue-400 border-b border-blue-500/30",
            "px-3 py-2 text-sm font-medium",
            "hover:bg-blue-500/25 transition-colors cursor-pointer",
          )}
        >
          <ChevronUp className="h-3.5 w-3.5" />
          {pendingEvents.length} new {pendingEvents.length === 1 ? "event" : "events"}
        </button>
      )}

      {/* Feed content */}
      <div ref={feedRef} className="flex-1 overflow-y-auto min-h-0">
        {/* Empty filter state */}
        {filteredEvents.length === 0 && events.length > 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Filter className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">
              No activity matches your filters
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              Try adjusting or clearing your filters to see more events.
            </p>
            <button
              onClick={clearAllFilters}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "transition-colors",
              )}
            >
              Clear filters
            </button>
          </div>
        )}

        {groupedEvents.map((group, groupIdx) => (
          <div key={`${group.period}-${groupIdx}`}>
            {/* Time period header */}
            <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/30 px-4 py-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {group.period}
              </span>
            </div>

            {/* Items in this period (single events + bulk groups) */}
            <div>
              {group.items.map((item) => {
                if (item.type === "single") {
                  navIndex++
                  return renderEventRow(item.event, navIndex)
                }

                // Bulk group
                const isExpanded = expandedGroups.has(item.groupKey)
                navIndex++
                const headerIdx = navIndex
                const headerFocused = headerIdx === focusedIndex

                return (
                  <div key={item.groupKey}>
                    {/* Bulk group header */}
                    <div
                      ref={(el) => {
                        if (el) {
                          itemRefs.current.set(headerIdx, el)
                        } else {
                          itemRefs.current.delete(headerIdx)
                        }
                      }}
                      className={cn(
                        "flex items-center gap-3 px-4 py-2.5 border-b border-border/20 transition-colors cursor-pointer select-none",
                        "hover:bg-accent/30",
                        headerFocused && "bg-accent/50 ring-1 ring-accent ring-inset",
                      )}
                      onClick={() => {
                        setFocusedIndex(headerIdx)
                        toggleGroup(item.groupKey)
                      }}
                      role="button"
                      aria-expanded={isExpanded}
                      tabIndex={-1}
                    >
                      {/* Expand/collapse chevron */}
                      <div className="mt-0.5">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>

                      {/* Group summary */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground shrink-0">
                            {item.actor}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            made {getBulkGroupSummary(item)}
                          </span>
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50 text-[11px] text-muted-foreground font-medium tabular-nums">
                            <Layers className="h-3 w-3" />
                            {item.events.length}
                          </span>
                        </div>
                      </div>

                      {/* Time range */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs text-muted-foreground/60 shrink-0 tabular-nums whitespace-nowrap">
                            {formatRelativeTime(item.events[0].timestamp)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left">
                          {formatAbsoluteTime(item.events[item.events.length - 1].timestamp)}
                          {" \u2013 "}
                          {formatAbsoluteTime(item.events[0].timestamp)}
                        </TooltipContent>
                      </Tooltip>
                    </div>

                    {/* Expanded sub-items */}
                    {isExpanded && (
                      <div className="border-l-2 border-muted/40 ml-6">
                        {item.events.map((subEvent) => {
                          navIndex++
                          return renderEventRow(subEvent, navIndex, true)
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        {/* Loading more indicator */}
        {loadingMore && (
          <div className="flex items-center justify-center py-4">
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* End of feed */}
        {!hasMore && filteredEvents.length > 0 && (
          <div className="text-center py-4 text-xs text-muted-foreground/50">End of activity</div>
        )}
      </div>
    </div>
  )
}
