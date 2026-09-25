import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { BeadDetailPanel } from "@/components/bead-detail-panel"
import { BeadTable } from "@/components/bead-table"
import { BeadTableBulkToolbar } from "@/components/bead-table-bulk-toolbar"
import { DevConsole } from "@/components/dev-console"
import { EpicTree } from "@/components/epic-tree"
import { FilterBar, type Filters } from "@/components/filter-bar"
import { Header } from "@/components/header"
import { useBdHealth, useWorkspaceGate } from "@/components/startup-gate"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useAppHealth } from "@/hooks/use-app-health"
import { useBeadActions } from "@/hooks/use-bead-actions"
import { useBeadSelection } from "@/hooks/use-bead-selection"
import { useDevConsole } from "@/hooks/use-dev-console"
import { useDevConsoleTaps } from "@/hooks/use-dev-console-taps"
import { useEpicNavigation } from "@/hooks/use-epic-navigation"
import { usePreferences } from "@/hooks/use-preferences"
import { useUpdateChecker } from "@/hooks/use-update-checker"
import { useViewport } from "@/hooks/use-viewport"
import { useWorkspaceLifecycle } from "@/hooks/use-workspace-lifecycle"
import { getAnalyticsEnabled, markAllBeadsRead, markBeadRead } from "@/lib/local-storage"
import { isMoleculePresentation } from "@/lib/molecule-presentation"
import { safeCapture } from "@/lib/posthog-safe"
import { rpc } from "@/lib/rpc"
import { sortEpics } from "@/lib/sort"
import { useSubscriptionChangeSignal } from "@/lib/subscribe"
import type { Bead, Epic } from "@/lib/types"

const getBlocksDependencies = rpc.epics.getBlocksDependencies

function readTypeFilter(workspaceId: string): string {
  try {
    return localStorage.getItem(`beadbox:issue-type:${workspaceId}`) || "all"
  } catch {
    return "all"
  }
}

const isBacklogged = (bead: Bead) => bead.priority === "backlog"
const isArchived = (bead: Bead) => Boolean(bead.labels?.includes("archived"))

export function partitionInactiveEpics(roots: Epic[]): {
  backlogEpics: Epic[]
  archivedEpics: Epic[]
} {
  return {
    backlogEpics: roots.filter((epic) => isBacklogged(epic) && !isArchived(epic)),
    archivedEpics: roots.filter(isArchived),
  }
}

export function filterActiveEpicTree(epic: Epic): Epic {
  const filterBeads = (beads: Bead[]): Bead[] =>
    beads
      .filter((bead) => !isBacklogged(bead) && !isArchived(bead))
      .map((bead) => (bead.children ? { ...bead, children: filterBeads(bead.children) } : bead))
  return {
    ...epic,
    children: filterBeads(epic.children ?? []),
    childEpics: epic.childEpics?.map(filterActiveEpicTree),
  }
}

export function collectGroupedVisibleBeads(
  active: Epic[],
  inactive: Epic[],
  backlogBeads: Bead[],
  archivedBeads: Bead[],
  matches: (bead: Bead) => boolean = () => true,
): Bead[] {
  const all = flattenEpicsToBeads([...active, ...inactive])
  return [
    ...new Map(
      [...all, ...backlogBeads, ...archivedBeads].filter(matches).map((bead) => [bead.id, bead]),
    ).values(),
  ]
}

import { ArrowLeft, Loader2, RefreshCw } from "lucide-react"
import { EpicTreeSkeleton } from "@/components/epic-tree-skeleton"
import { IncompatibilityBanner } from "@/components/incompatibility-banner"
import { LoadErrorEmpty } from "@/components/load-error-overlay"
import { OnboardingHero } from "@/components/onboarding-hero"
import { SettingsDialog, type SettingsTab } from "@/components/settings-dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { UpdateDialog } from "@/components/update-dialog"
import {
  countAllBeads,
  extractAssignees,
  extractRigNames,
  filterEpics,
  flattenEpicsToBeads,
  groupBeadsByStatus,
  matchesBead,
} from "@/lib/epic-tree-utils"
import { getVersionStatus } from "@/lib/version-requirements"

function BeadsEpicsViewer() {
  const { workspaces: initialWorkspaces } = useWorkspaceGate()
  const { bdVersion, platform } = useBdHealth()
  const prefs = usePreferences()
  const {
    filters,
    sort,
    setSort,
    theme,
    handleThemeChange,
    zoomLevel,
    handleZoomChange,
    filterBarVisible,
    vimEnabled,
    handleVimNavigationChange,
    updateCheckEnabled,
    handleUpdateCheckEnabledChange,
    updateCheckFrequency,
    handleUpdateCheckFrequencyChange,
    showRcVersion,
    isTauriRef,
  } = prefs

  // Wrap setFilters to scroll tree to top on filter change
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const setFilters = useCallback(
    (f: Filters) => {
      prefs.setFilters(f)
      if (treeContainerRef.current) treeContainerRef.current.scrollTop = 0
      // eslint-disable-next-line react-hooks/exhaustive-deps -- only depends on the stable setFilters function, not the whole prefs object
    },
    [prefs.setFilters],
  )

  // Drag and drop state
  const [draggedBeadId, setDraggedBeadId] = useState<string | null>(null)
  const [dragOverEpicId, setDragOverEpicId] = useState<string | null>(null)

  // bb-y729: page-level bulk selection. Lives here so the same set is shared
  // across every <BeadTable> mount (flat-table + per-epic tables in EpicTree).
  const beadSelection = useBeadSelection()
  const [isBulkArchiving, setIsBulkArchiving] = useState(false)

  const { isMobileLayout } = useViewport()

  const {
    updateAvailable,
    checking: updateChecking,
    checkNow: checkForUpdates,
    checkError: updateCheckError,
    dismissUpdate,
  } = useUpdateChecker({
    enabled: updateCheckEnabled,
    frequency: updateCheckFrequency,
  })

  useEffect(() => {
    if (updateAvailable) {
      console.log(
        `[update-checker] Update available: v${updateAvailable.version} (current: v${import.meta.env.VITE_BUILD_TAG || import.meta.env.VITE_APP_VERSION})`,
      )
    }
  }, [updateAvailable])

  // Unified health state machine (replaces serverHealthy, loadError, pollingHealthy bridge)
  const {
    health: appHealth,
    healthRef: appHealthRef,
    setHealthy,
    setDegraded,
    setError: setHealthError,
    setFatal,
  } = useAppHealth()

  // Workspace lifecycle: loading, retry, workspace switching, read state
  const lifecycle = useWorkspaceLifecycle({
    initialWorkspaces,
    appHealth,
    appHealthRef,
    setHealthy,
    setDegraded,
    setHealthError,
    setFatal,
  })
  const {
    currentWorkspace,
    includeSystem,
    setIncludeSystem,
    availableTypes,
    typeCatalogReady,
    typeCatalogError,
    typeCatalogRetrying,
    retryAvailableTypes,
    epics,
    setEpics,
    isLoading,
    isRefreshing,
    loadingWorkspaceId,
    isSlowLoad,
    loadError,
    autoRetryCountdown,
    flockContention,
    flockBanner,
    setFlockBanner,
    removeConfirm,
    setRemoveConfirm,
    removingWorkspaceId,
    readState,
    setReadStateLocal,
    availableStatuses,
    customStatusChain,
    refreshAvailableStatuses,
    hasExistingDataRef,
    loadEpics,
    handleManualRetry,
    handleRefresh,
    doRemoveWorkspace,
  } = lifecycle

  // Settings dialog state
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined)

  // Version compatibility check for the incompatibility banner
  const bdCheck = useMemo(
    () => getVersionStatus("bd", bdVersion ?? null, platform),
    [bdVersion, platform],
  )

  const handleOpenSettingsToHelp = useCallback(() => {
    setSettingsInitialTab("help")
    setSettingsOpen(true)
  }, [])

  // Update dialog state
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  const assignees = useMemo(() => extractAssignees(epics), [epics])
  const rigNames = useMemo(() => extractRigNames(epics), [epics])
  const [typesByWorkspace, setTypesByWorkspace] = useState<Record<string, string>>({})
  const selectedType = currentWorkspace
    ? (typesByWorkspace[currentWorkspace.id] ?? readTypeFilter(currentWorkspace.id))
    : "all"
  const typeOptions = useMemo(
    () => [
      ...new Set([
        ...availableTypes,
        ...epics.map((epic) => epic.type),
        ...flattenEpicsToBeads(epics).map((bead) => bead.type),
      ]),
    ],
    [availableTypes, epics],
  )
  const filteredEpics = useMemo(
    () => filterEpics(epics, { ...filters, type: selectedType, includeSystem }, rigNames),
    [epics, filters, rigNames, selectedType, includeSystem],
  )
  const sortedEpics = useMemo(() => sortEpics(filteredEpics, sort), [filteredEpics, sort])

  // Split epics into active, backlog, and archived
  // Archived takes precedence over backlog (if both labels exist, show in archived)
  const activeEpics = useMemo(
    () =>
      sortedEpics.filter(
        (e) =>
          e.type !== "convoy" &&
          e.type !== "milestone" &&
          !isMoleculePresentation(e) &&
          !e.labels?.includes("archived") &&
          !isBacklogged(e),
      ),
    [sortedEpics],
  )
  const activeMilestones = useMemo(
    () =>
      sortedEpics.filter(
        (e) => e.type === "milestone" && !e.labels?.includes("archived") && !isBacklogged(e),
      ),
    [sortedEpics],
  )
  const activeConvoys = useMemo(
    () =>
      sortedEpics.filter(
        (e) => e.type === "convoy" && !e.labels?.includes("archived") && !isBacklogged(e),
      ),
    [sortedEpics],
  )
  const activeMolecules = useMemo(
    () =>
      sortedEpics.filter(
        (e) => isMoleculePresentation(e) && !e.labels?.includes("archived") && !isBacklogged(e),
      ),
    [sortedEpics],
  )
  const { backlogEpics, archivedEpics } = useMemo(
    () => partitionInactiveEpics(sortedEpics),
    [sortedEpics],
  )

  // Extract ALL backlogged beads from anywhere in the tree
  const backlogBeads = useMemo(() => {
    const result: Bead[] = []

    function extractBackloggedBeads(beads: Bead[]) {
      for (const bead of beads) {
        if (isBacklogged(bead) && !isArchived(bead)) {
          result.push(bead)
        }
        if (bead.children) {
          extractBackloggedBeads(bead.children)
        }
      }
    }

    function extractFromEpic(epic: Epic) {
      if (epic.children) {
        extractBackloggedBeads(epic.children)
      }
      if (epic.childEpics) {
        epic.childEpics.forEach(extractFromEpic)
      }
    }

    // Scan all epics (including standalone)
    sortedEpics.forEach(extractFromEpic)

    return result
  }, [sortedEpics])

  // Extract ALL archived beads from anywhere in the tree (mirrors backlogBeads pattern)
  const archivedBeads = useMemo(() => {
    const result: Bead[] = []

    function extractArchivedBeads(beads: Bead[]) {
      for (const bead of beads) {
        if (isArchived(bead)) {
          result.push(bead)
        }
        if (bead.children) {
          extractArchivedBeads(bead.children)
        }
      }
    }

    function extractFromEpic(epic: Epic) {
      if (epic.children) {
        extractArchivedBeads(epic.children)
      }
      if (epic.childEpics) {
        epic.childEpics.forEach(extractFromEpic)
      }
    }

    // Scan all epics (including standalone)
    sortedEpics.forEach(extractFromEpic)

    return result
  }, [sortedEpics])

  // Child epics stay under their parent even when backlogged or archived.
  const activeEpicsWithFilteredStandalone = useMemo(
    () => activeEpics.map(filterActiveEpicTree),
    [activeEpics],
  )
  const activeMilestonesFiltered = useMemo(
    () => activeMilestones.map(filterActiveEpicTree),
    [activeMilestones],
  )
  const activeConvoysFiltered = useMemo(
    () => activeConvoys.map(filterActiveEpicTree),
    [activeConvoys],
  )
  const activeMoleculesFiltered = useMemo(
    () => activeMolecules.map(filterActiveEpicTree),
    [activeMolecules],
  )

  // Detect workspaces with no real epics/convoys (e.g. Gastown).
  // Uses raw epics (pre-filter) so the layout mode is stable regardless of
  // active filters. Convoys and real epics both have id !== "_standalone".
  const hasRealEpics = useMemo(() => {
    return epics.some((e) => e.id !== "_standalone")
  }, [epics])

  // Flat bead list for no-epic workspaces: extract from _standalone pseudo-epic
  const flatBeads = useMemo(() => {
    if (hasRealEpics) return []
    const standalone = activeEpicsWithFilteredStandalone.find((e) => e.id === "_standalone")
    return standalone?.children ?? []
  }, [hasRealEpics, activeEpicsWithFilteredStandalone])

  // Ref bridge: useEpicNavigation needs updateBeadInEpics for detail fetching,
  // but useBeadActions (which provides it) needs selectedBead from the nav hook.
  // The ref is only read inside async .then() callbacks, so it's always current.
  const updateBeadInEpicsRef = useRef<(beadId: string, fn: (bead: Bead) => Bead) => void>(() => {})

  const nav = useEpicNavigation({
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
    onOpenSettings: () => {
      setSettingsInitialTab(undefined)
      setSettingsOpen(true)
    },
    onToggleFilterBar: prefs.setFilterBarVisible,
    onBeadRead: (beadId, bead) => {
      setReadStateLocal(markBeadRead(beadId, bead))
    },
    onMarkAllRead: (beads) => {
      setReadStateLocal(markAllBeadsRead(beads))
    },
    updateBeadInEpicsRef,
    activeEpicsFiltered: activeEpicsWithFilteredStandalone,
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
  })
  const {
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
    handleToggleEpic,
    handleSetExpandedEpics,
    handleToggleBead,
    handleBeadClick,
    handleBeadNavigate,
    handleCloseDetail,
  } = nav

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced app_search_used event: fires 500ms after the user stops typing in search
  useEffect(() => {
    if (!filters.search) return
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    searchDebounceRef.current = setTimeout(() => {
      if (!getAnalyticsEnabled()) return
      safeCapture("app_search_used", {
        query_length: filters.search.length,
        result_count: countAllBeads(filteredEpics),
        selected: false,
      })
    }, 500)
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [filters.search, filteredEpics])

  // beadbox-s5z: bead-list auto-refresh on subscription change.
  // bb-pgb0.1 (delete useWebSocket shim, commit 5580928) claimed real-time
  // invalidation flows through queryClient.invalidateQueries + bumpSubscription
  // Change per pm/systemdesign.md §3.2. home-page.tsx is neither a useQuery
  // consumer nor a useSubscriptionChangeSignal consumer, so external bd writes
  // never triggered loadEpics. Mirror the workspaces-page.tsx / activity-page.tsx
  // pattern: read the signal, refetch on bump. The bump also drives epicEpoch
  // forward so the deferred blocks-patching useEffect below re-runs and the
  // refreshed tree gets its blockedBy data re-resolved.
  const subscriptionSignal = useSubscriptionChangeSignal()

  // Deferred blocks loading: after the initial tree renders, fetch blockedBy
  // data and patch it into the existing epics. This shaves ~53ms off the
  // perceived initial load since the tree appears before blocks resolve.
  // epicEpoch increments on each subscription refresh so blocks are re-fetched
  // after the tree is replaced (the fresh tree from incrementalRefresh lacks
  // blockedBy).
  const blocksLoadIdRef = useRef(0)
  const [epicEpoch, setEpicEpoch] = useState(0)

  useEffect(() => {
    if (subscriptionSignal === 0) return
    if (!currentWorkspace?.databasePath) return
    void loadEpics()
    setEpicEpoch((prev) => prev + 1)
  }, [subscriptionSignal, currentWorkspace?.databasePath, loadEpics])
  useEffect(() => {
    void epicEpoch
    if (isLoading || !currentWorkspace?.databasePath || epics.length === 0) return

    const loadId = ++blocksLoadIdRef.current
    const workspaceId = currentWorkspace.id

    getBlocksDependencies(workspaceId).then((blocksMap) => {
      if (blocksLoadIdRef.current !== loadId) return // stale
      if (Object.keys(blocksMap).length === 0) return

      setEpics((prev) => {
        // Build title lookup from the already-loaded tree
        const titleById = new Map<string, string>()
        function indexBead(b: Bead) {
          titleById.set(b.id, b.title)
          b.children?.forEach(indexBead)
        }
        function indexEpic(e: Epic) {
          indexBead(e)
          e.children.forEach(indexBead)
          e.childEpics?.forEach(indexEpic)
        }
        prev.forEach(indexEpic)

        function patchBead(bead: Bead): Bead {
          const blockerIds = blocksMap[bead.id]
          const patched = blockerIds
            ? {
                ...bead,
                blockedBy: blockerIds.map((id) => ({ id, title: titleById.get(id) || id })),
              }
            : bead
          if (patched.children) {
            const patchedChildren = patched.children.map(patchBead)
            if (patchedChildren.some((c, i) => c !== patched.children![i])) {
              return { ...patched, children: patchedChildren }
            }
          }
          return patched
        }

        function patchEpic(epic: Epic): Epic {
          const base = patchBead(epic) as Epic
          const patchedChildren = base.children.map(patchBead)
          const patchedChildEpics = base.childEpics?.map(patchEpic)
          const childrenChanged = patchedChildren.some((c, i) => c !== base.children[i])
          const childEpicsChanged = patchedChildEpics?.some((c, i) => c !== base.childEpics![i])
          if (childrenChanged || childEpicsChanged) {
            return {
              ...base,
              children: patchedChildren,
              childEpics: patchedChildEpics ?? base.childEpics,
            }
          }
          return base
        }

        const patched = prev.map(patchEpic)
        return patched.some((e, i) => e !== prev[i]) ? patched : prev
      })
    })
  }, [
    isLoading,
    currentWorkspace?.databasePath,
    currentWorkspace?.id,
    epics.length,
    epicEpoch,
    setEpics,
  ])

  // bb-pgb0.1: deleted ~130 lines of dead WebSocket-shim plumbing
  // (handleSSEChange + bdCmdHandlerRef + lifecycleHandlerRef +
  // useWebSocket destructure + wsConnectedRef sync + prev-ws reload
  // effect). All authorized retired per pm/systemdesign.md §3.3 — the
  // shim's useWebSocket returned hardcoded values and NEVER fired the
  // passed-in onChange/onBdCommand/onLifecycleEvent callbacks, so the
  // refs and handlers had no callers. Real-time invalidation now flows
  // through the central useChangeSubscription in routes/__root.tsx
  // (queryClient.invalidateQueries + bumpSubscriptionChange per §3.2);
  // dev-console event taps come from setRpcTap/setSubscriptionTap via
  // useDevConsoleTaps below.
  const devConsole = useDevConsole({ dbPath: currentWorkspace?.databasePath })

  useDevConsoleTaps(devConsole)

  const handleExecuteCommand = useCallback(
    async (args: string[]) => {
      // bb-ck7j: was fetch("/api/console") — Next.js API route is dead in
      // v0.25 (no /api routes in the Vite SPA). Route to rpc.console.run
      // which goes through the kkrpc bridge to the Bun sidecar's allowlisted
      // bd-CLI shell-out. The rpc tap skips the "console" namespace; we emit
      // here with source="console" + actual stdout/stderr so the Commands
      // tab can render output (DevConsoleCommands shows event.stdout only
      // when source === "console").
      const db = currentWorkspace?.databasePath
      const startMs = Date.now()
      const result = await rpc.console.run({ args, db })
      devConsole.addCommand({
        type: "bd_command",
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        command: args[0] ?? "",
        args: args.slice(1),
        dbPath: db ?? null,
        durationMs: Date.now() - startMs,
        exitCode: result.exitCode,
        resultSummary: result.error,
        stderr: result.stderr || null,
        stdout: result.stdout || null,
        source: "console",
      })
      if (result.error || result.exitCode !== 0) {
        throw new Error(result.error ?? result.stderr ?? `Exit ${result.exitCode}`)
      }
    },
    [currentWorkspace?.databasePath, devConsole.addCommand],
  )

  // bb-pgb0.1: deleted the wsConnected disconnect-banner effect + the
  // pollingHealthy degrade/recover effect. Both keyed on the dead
  // useWebSocket shim's hardcoded values (connected always true,
  // healthy always true) so neither branch ever fired in production.
  // Per pm/systemdesign.md §3.3, the disconnect-banner +
  // app_health_degraded responsibility now lives in lib/subscribe.ts's
  // polling_error / recovered handlers, which fire regardless of which
  // page is mounted.

  const actions = useBeadActions({
    epics,
    setEpics,
    currentWorkspace,
    selectedBead,
    setSelectedBead: (b: React.SetStateAction<Bead | null>) => setSelectedBead(b),
    loadEpics,
    handleCloseDetail,
    treeContainerRef,
    backlogEpics,
    archivedEpics,
    archivedBeads,
  })
  const {
    isPending,
    deleteConfirmId,
    setDeleteConfirmId,
    isDeleting,
    epicCloseConfirm,
    setEpicCloseConfirm,
    handleBeadUpdate,
    handleAddComment,
    handleDelete,
    handleBeadMove,
    canMoveEpic,
    handleArchive,
    handleArchiveBead,
    handleBacklog,
    handleEpicCloseWithChildren,
    handleEpicCloseOnly,
  } = actions

  // Complete the ref bridge: now useEpicNavigation's detail fetcher can reach updateBeadInEpics
  updateBeadInEpicsRef.current = actions.updateBeadInEpics

  // bb-y729: bulk archive handler — loops bd update --add-label archived per id
  // via the kkrpc handler. Per-id failures surface as a toast; successes drop
  // out of the selection set. Reload epics once at the end so the UI reflects
  // the merged label state.
  const handleBulkArchive = useCallback(async () => {
    const ids = Array.from(beadSelection.selectedIds)
    if (ids.length === 0) return
    setIsBulkArchiving(true)
    try {
      const result = await rpc.beads.archiveBeads(ids, currentWorkspace?.id)
      const failed = result.results.filter((r) => !r.success)
      if (failed.length > 0) {
        toast.error(
          `Archived ${result.results.length - failed.length} of ${ids.length}; ${failed.length} failed`,
          { description: failed.map((f) => `${f.id}: ${f.error ?? "unknown"}`).join("\n") },
        )
      } else {
        toast.success(`Archived ${ids.length} ${ids.length === 1 ? "bead" : "beads"}`)
      }
      beadSelection.clear()
      await loadEpics()
    } catch (error) {
      toast.error("Bulk archive failed", { description: String(error) })
    } finally {
      setIsBulkArchiving(false)
    }
  }, [beadSelection, currentWorkspace?.id, loadEpics])

  // bb-y729: prune selection on filter change so beads that filter out drop
  // from the selection set (per spec: 'filter change → selection prunes to
  // remaining-visible rows'). Filter-bar already triggers re-render of
  // activeEpicsWithFilteredStandalone, so we walk those + flatBeads.
  useEffect(() => {
    void filters
    if (beadSelection.selectedIds.size === 0) return
    const visible = new Set<string>()
    const collect = (items: (Bead | Epic)[]) => {
      for (const it of items) {
        visible.add(it.id)
        if (it.children) collect(it.children)
        if ("childEpics" in it && it.childEpics) collect(it.childEpics)
      }
    }
    collect(flatBeads)
    collect(activeEpicsWithFilteredStandalone)
    collect(activeMilestonesFiltered)
    collect(activeConvoysFiltered)
    collect(activeMoleculesFiltered)
    collect(backlogEpics)
    collect(backlogBeads)
    collect(archivedEpics)
    collect(archivedBeads)
    beadSelection.pruneTo(Array.from(visible))
  }, [
    filters,
    beadSelection.selectedIds.size,
    beadSelection.pruneTo,
    flatBeads,
    activeEpicsWithFilteredStandalone,
    activeMilestonesFiltered,
    activeConvoysFiltered,
    activeMoleculesFiltered,
    backlogEpics,
    backlogBeads,
    archivedEpics,
    archivedBeads,
  ])

  const groupedBeads = useMemo(() => {
    const groupedFilters: Filters = {
      ...filters,
      type: selectedType,
      includeSystem,
      rig: filters.rig !== "all" && rigNames.length === 0 ? "all" : filters.rig,
    }
    return collectGroupedVisibleBeads(
      [
        ...activeEpicsWithFilteredStandalone,
        ...activeMilestonesFiltered,
        ...activeMoleculesFiltered,
        ...activeConvoysFiltered,
      ],
      [...backlogEpics, ...archivedEpics],
      backlogBeads,
      archivedBeads,
      (bead) => matchesBead(bead, groupedFilters),
    )
  }, [
    activeEpicsWithFilteredStandalone,
    activeMilestonesFiltered,
    activeMoleculesFiltered,
    activeConvoysFiltered,
    backlogEpics,
    archivedEpics,
    backlogBeads,
    archivedBeads,
    filters,
    selectedType,
    includeSystem,
    rigNames,
  ])

  // Drag and drop handlers
  const handleDragStart = useCallback((beadId: string) => {
    setDraggedBeadId(beadId)
  }, [])

  const handleDragEnd = useCallback(() => {
    setDraggedBeadId(null)
    setDragOverEpicId(null)
  }, [])

  const handleDragOver = useCallback((epicId: string | null) => {
    setDragOverEpicId(epicId)
  }, [])

  // beadbox-brg: shared grouped-by-status renderer. Used at three render sites:
  //  - flat-list workspaces (no real epics) — input is `flatBeads`
  //  - desktop epic-tree view when filters.grouped — input is flattened epic tree
  //  - mobile epic-tree view when filters.grouped — same input as desktop
  // The status filter has already applied (filterEpics drops non-matching
  // beads), so the input here is the already-narrowed set; grouping is
  // purely layout.
  const renderGroupedFlatView = (sourceBeads: Bead[]) => (
    <div className="space-y-3">
      {groupBeadsByStatus(sourceBeads, customStatusChain).map((group) => (
        <div key={group.status} className="space-y-1">
          <div className="px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label} <span className="font-normal">({group.beads.length})</span>
          </div>
          <BeadTable
            beads={group.beads}
            epicId={`_grouped_${group.status}`}
            onBeadClick={handleBeadClick}
            onArchive={handleArchiveBead}
            onDelete={setDeleteConfirmId}
            expandedBeads={expandedBeads}
            onToggleBead={handleToggleBead}
            focusedItemId={focusedItemId}
            onFocusItem={setFocusedItemId}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            draggedBeadId={draggedBeadId}
            selectedBeadId={beadIdParam}
            showWaves={filters.showWaves}
            readState={readState}
            selectedIds={beadSelection.selectedIds}
            onToggleSelect={beadSelection.toggle}
            onToggleSelectAll={beadSelection.toggleAll}
          />
        </div>
      ))}
    </div>
  )

  return (
    <div className="h-full flex flex-col bg-background safe-area-inset">
      <Header
        currentWorkspace={
          currentWorkspace || { id: "", name: "Loading...", mode: "embedded" as const }
        }
        loadingWorkspaceId={loadingWorkspaceId}
        isPending={isPending}
        appHealth={appHealth}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing || flockContention}
        updateAvailable={updateAvailable}
        onUpdateClick={() => setUpdateDialogOpen(true)}
        versionLabel={
          showRcVersion
            ? `v${import.meta.env.VITE_BUILD_TAG || import.meta.env.VITE_APP_VERSION || "0.0.0"}`
            : undefined
        }
        onSettingsOpen={() => {
          setSettingsInitialTab(undefined)
          setSettingsOpen(true)
        }}
        autoRetryCountdown={autoRetryCountdown}
      />

      <IncompatibilityBanner bdCheck={bdCheck} onOpenSettings={handleOpenSettingsToHelp} />

      {flockBanner && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2">
          <div className="flex items-center justify-between max-w-screen-xl mx-auto">
            <div className="flex items-center gap-2 text-amber-400">
              <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0" />
              <span className="text-sm">Workspace busy, data may be outdated</span>
            </div>
            <button
              onClick={() => setFlockBanner(false)}
              className="text-amber-400/70 hover:text-amber-300 text-xs px-2 py-1 rounded hover:bg-amber-500/20 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <main
        className="flex-1 flex flex-col px-3 md:px-6 py-4 min-h-0"
        style={devConsole.open ? { marginBottom: devConsole.height } : undefined}
      >
        {typeCatalogError && (
          <div
            role="alert"
            className="mb-3 flex items-center justify-between gap-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
          >
            <span>
              Could not load issue types: {typeCatalogError}. Type changes are unavailable.
            </span>
            <button
              type="button"
              onClick={retryAvailableTypes}
              disabled={typeCatalogRetrying}
              className="shrink-0 rounded px-2 py-1 font-medium hover:bg-amber-500/20 disabled:cursor-wait disabled:opacity-60"
            >
              {typeCatalogRetrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {/* Filter bar: hidden on mobile when viewing bead detail, or when toggled off via Cmd+F */}
        {filterBarVisible && !(isMobileLayout && beadIdParam) && (
          <div className="mb-4">
            <FilterBar
              filters={filters}
              onFiltersChange={setFilters}
              assignees={assignees}
              rigNames={rigNames}
              availableStatuses={availableStatuses}
              availableTypes={typeOptions}
              selectedType={selectedType}
              onTypeChange={(type) => {
                if (!currentWorkspace) return
                try {
                  localStorage.setItem(`beadbox:issue-type:${currentWorkspace.id}`, type)
                } catch {
                  /* storage may be unavailable */
                }
                setTypesByWorkspace((current) => ({ ...current, [currentWorkspace.id]: type }))
              }}
              includeSystem={includeSystem}
              onIncludeSystemChange={setIncludeSystem}
              sort={sort}
              onSortChange={setSort}
            />
          </div>
        )}

        {isMobileLayout ? (
          /* Mobile: stacked single-panel layout */
          beadIdParam ? (
            /* Mobile detail view */
            <div className="flex-1 flex flex-col min-h-0">
              {/* Back button header */}
              <button
                onClick={handleCloseDetail}
                className="flex items-center gap-2 py-2 mb-2 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0 min-h-[44px]"
              >
                <ArrowLeft className="h-4 w-4" />
                <span>Back to list</span>
              </button>
              <div className="flex-1 min-h-0">
                <BeadDetailPanel
                  ref={detailPanelRef}
                  bead={selectedBead}
                  onClose={handleCloseDetail}
                  onUpdate={handleBeadUpdate}
                  onAddComment={handleAddComment}
                  onDelete={setDeleteConfirmId}
                  onBeadNavigate={handleBeadNavigate}
                  parentPath={parentPath}
                  dbPath={currentWorkspace?.id}
                  assignees={assignees}
                  availableStatuses={availableStatuses}
                  availableTypes={typeOptions}
                  typeCatalogReady={typeCatalogReady}
                  customStatusChain={customStatusChain}
                  isLoadingBead={isLoadingBead}
                  isFocused={focusedPanel === "right"}
                  onFocus={() => setFocusedPanel("right")}
                />
              </div>
            </div>
          ) : (
            /* Mobile tree/table view */
            <>
              {/* bb-y729: bulk-action toolbar (mobile) */}
              <BeadTableBulkToolbar
                selectedCount={beadSelection.selectedIds.size}
                onBulkArchive={handleBulkArchive}
                onClear={beadSelection.clear}
                isPending={isBulkArchiving}
              />
              <div ref={treeContainerRef} className="flex-1 overflow-y-auto hide-scrollbar">
                {/* beadbox-dme: gate skeleton on first-ever-load, not "currently
                  loading + empty". beadbox-s5z's loadEpics wiring flips
                  isLoading on every subscription tick; on empty workspaces
                  that triggered a skeleton flash every ~1s. hasExistingDataRef
                  is true once we've successfully loaded at least one set of
                  epics (even an empty one), so subsequent refetches keep the
                  existing rendered state until the fresh data lands. */}
                {isLoading && !hasExistingDataRef.current ? (
                  <EpicTreeSkeleton isSlowLoad={isSlowLoad} />
                ) : !hasRealEpics &&
                  flatBeads.length > 0 &&
                  archivedBeads.length === 0 &&
                  backlogBeads.length === 0 ? (
                  /* Flat table for workspaces with no epics (e.g. Gastown).
                   beadbox-brg: when filters.grouped is on, render via the
                   shared status-grouped helper instead of a single table. */
                  filters.grouped ? (
                    renderGroupedFlatView(flatBeads)
                  ) : (
                    <div className="space-y-1">
                      <BeadTable
                        beads={flatBeads}
                        epicId="_flat"
                        onBeadClick={handleBeadClick}
                        onArchive={handleArchiveBead}
                        onDelete={setDeleteConfirmId}
                        expandedBeads={expandedBeads}
                        onToggleBead={handleToggleBead}
                        focusedItemId={focusedItemId}
                        onFocusItem={setFocusedItemId}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        draggedBeadId={draggedBeadId}
                        selectedBeadId={beadIdParam}
                        showWaves={filters.showWaves}
                        readState={readState}
                        selectedIds={beadSelection.selectedIds}
                        onToggleSelect={beadSelection.toggle}
                        onToggleSelectAll={beadSelection.toggleAll}
                      />
                    </div>
                  )
                ) : activeEpicsWithFilteredStandalone.some(
                    (e) => e.id !== "_standalone" || (e.children?.length ?? 0) > 0,
                  ) ||
                  activeMilestonesFiltered.length > 0 ||
                  activeConvoys.length > 0 ||
                  activeMolecules.length > 0 ||
                  backlogEpics.length > 0 ||
                  backlogBeads.length > 0 ||
                  archivedEpics.length > 0 ||
                  archivedBeads.length > 0 ? (
                  filters.grouped ? (
                    renderGroupedFlatView(groupedBeads)
                  ) : (
                    <EpicTree
                      epics={activeEpicsWithFilteredStandalone}
                      milestones={activeMilestonesFiltered}
                      convoys={activeConvoysFiltered}
                      molecules={activeMoleculesFiltered}
                      archivedEpics={archivedEpics}
                      archivedBeads={archivedBeads}
                      backlogEpics={backlogEpics}
                      backlogBeads={backlogBeads}
                      expandedEpics={expandedEpics}
                      onToggleEpic={handleToggleEpic}
                      onSetExpandedEpics={handleSetExpandedEpics}
                      onBeadClick={handleBeadClick}
                      onDelete={setDeleteConfirmId}
                      onBeadMove={handleBeadMove}
                      canMoveEpic={canMoveEpic}
                      dragOverEpicId={dragOverEpicId}
                      onDragOver={handleDragOver}
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      draggedBeadId={draggedBeadId}
                      expandedBeads={expandedBeads}
                      onToggleBead={handleToggleBead}
                      focusedItemId={focusedItemId}
                      onFocusItem={setFocusedItemId}
                      onArchive={handleArchive}
                      onBacklog={handleBacklog}
                      selectedIds={beadSelection.selectedIds}
                      onToggleSelect={beadSelection.toggle}
                      onToggleSelectAll={beadSelection.toggleAll}
                      selectedBeadId={beadIdParam}
                      showWaves={filters.showWaves}
                      readState={readState}
                    />
                  )
                ) : epics.length === 0 && loadError && loadError.category !== "flock-contention" ? (
                  <LoadErrorEmpty
                    error={loadError}
                    onRetry={handleManualRetry}
                    isRetrying={isLoading}
                    databasePath={currentWorkspace?.databasePath ?? ""}
                    autoRetryCountdown={autoRetryCountdown}
                  />
                ) : epics.length === 0 && flockContention ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
                    <RefreshCw className="h-5 w-5 animate-spin" />
                    <span className="text-sm">Workspace busy, loading data...</span>
                  </div>
                ) : epics.length === 0 ? (
                  <OnboardingHero />
                ) : (
                  <div className="text-center py-12 text-muted-foreground">
                    No epics or beads match your filters
                  </div>
                )}
              </div>
            </>
          )
        ) : (
          /* Desktop: side-by-side resizable panels */
          <ResizablePanelGroup
            direction="horizontal"
            className="flex-1 min-h-0"
            autoSaveId="beads-panel-layout"
          >
            {/* Left Panel: Epic Tree or Flat Table */}
            <ResizablePanel defaultSize={55} minSize={30} className="flex flex-col">
              {/* bb-y729: bulk-action toolbar — visible when ≥1 bead selected */}
              <BeadTableBulkToolbar
                selectedCount={beadSelection.selectedIds.size}
                onBulkArchive={handleBulkArchive}
                onClear={beadSelection.clear}
                isPending={isBulkArchiving}
              />
              <div
                ref={treeContainerRef}
                className="flex-1 min-h-0 overflow-y-auto pr-4 hide-scrollbar"
              >
                {/* beadbox-dme: see mobile branch comment above. */}
                {isLoading && !hasExistingDataRef.current ? (
                  <EpicTreeSkeleton isSlowLoad={isSlowLoad} />
                ) : !hasRealEpics &&
                  flatBeads.length > 0 &&
                  archivedBeads.length === 0 &&
                  backlogBeads.length === 0 ? (
                  /* Flat table for workspaces with no epics (e.g. Gastown) */
                  filters.grouped ? (
                    renderGroupedFlatView(flatBeads)
                  ) : (
                    <div className="space-y-1">
                      <BeadTable
                        beads={flatBeads}
                        epicId="_flat"
                        onBeadClick={handleBeadClick}
                        onArchive={handleArchiveBead}
                        onDelete={setDeleteConfirmId}
                        expandedBeads={expandedBeads}
                        onToggleBead={handleToggleBead}
                        focusedItemId={focusedItemId}
                        onFocusItem={setFocusedItemId}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        draggedBeadId={draggedBeadId}
                        selectedBeadId={beadIdParam}
                        showWaves={filters.showWaves}
                        readState={readState}
                      />
                    </div>
                  )
                ) : activeEpicsWithFilteredStandalone.some(
                    (e) => e.id !== "_standalone" || (e.children?.length ?? 0) > 0,
                  ) ||
                  activeMilestonesFiltered.length > 0 ||
                  activeConvoys.length > 0 ||
                  activeMolecules.length > 0 ||
                  backlogEpics.length > 0 ||
                  backlogBeads.length > 0 ||
                  archivedEpics.length > 0 ||
                  archivedBeads.length > 0 ? (
                  filters.grouped ? (
                    renderGroupedFlatView(groupedBeads)
                  ) : (
                    <EpicTree
                      epics={activeEpicsWithFilteredStandalone}
                      milestones={activeMilestonesFiltered}
                      convoys={activeConvoysFiltered}
                      molecules={activeMoleculesFiltered}
                      archivedEpics={archivedEpics}
                      archivedBeads={archivedBeads}
                      backlogEpics={backlogEpics}
                      backlogBeads={backlogBeads}
                      expandedEpics={expandedEpics}
                      onToggleEpic={handleToggleEpic}
                      onSetExpandedEpics={handleSetExpandedEpics}
                      onBeadClick={handleBeadClick}
                      onDelete={setDeleteConfirmId}
                      onBeadMove={handleBeadMove}
                      canMoveEpic={canMoveEpic}
                      dragOverEpicId={dragOverEpicId}
                      onDragOver={handleDragOver}
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      draggedBeadId={draggedBeadId}
                      expandedBeads={expandedBeads}
                      onToggleBead={handleToggleBead}
                      focusedItemId={focusedItemId}
                      onFocusItem={setFocusedItemId}
                      onArchive={handleArchive}
                      onBacklog={handleBacklog}
                      selectedBeadId={beadIdParam}
                      showWaves={filters.showWaves}
                      readState={readState}
                      selectedIds={beadSelection.selectedIds}
                      onToggleSelect={beadSelection.toggle}
                      onToggleSelectAll={beadSelection.toggleAll}
                    />
                  )
                ) : epics.length === 0 && loadError && loadError.category !== "flock-contention" ? (
                  <LoadErrorEmpty
                    error={loadError}
                    onRetry={handleManualRetry}
                    isRetrying={isLoading}
                    databasePath={currentWorkspace?.databasePath ?? ""}
                    autoRetryCountdown={autoRetryCountdown}
                  />
                ) : epics.length === 0 && flockContention ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
                    <RefreshCw className="h-5 w-5 animate-spin" />
                    <span className="text-sm">Workspace busy, loading data...</span>
                  </div>
                ) : epics.length === 0 ? (
                  <OnboardingHero />
                ) : (
                  <div className="text-center py-12 text-muted-foreground">
                    No epics or beads match your filters
                  </div>
                )}
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Detail Panel - Right Panel */}
            <ResizablePanel defaultSize={45} minSize={20} className="flex flex-col">
              <div className="flex-1 min-h-0 overflow-hidden pl-4">
                <BeadDetailPanel
                  ref={detailPanelRef}
                  bead={selectedBead}
                  onClose={handleCloseDetail}
                  onUpdate={handleBeadUpdate}
                  onAddComment={handleAddComment}
                  onDelete={setDeleteConfirmId}
                  onBeadNavigate={handleBeadNavigate}
                  parentPath={parentPath}
                  dbPath={currentWorkspace?.id}
                  assignees={assignees}
                  availableStatuses={availableStatuses}
                  availableTypes={typeOptions}
                  typeCatalogReady={typeCatalogReady}
                  customStatusChain={customStatusChain}
                  isLoadingBead={isLoadingBead}
                  isFocused={focusedPanel === "right"}
                  onFocus={() => setFocusedPanel("right")}
                />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        theme={theme}
        onThemeChange={handleThemeChange}
        zoomLevel={zoomLevel}
        onZoomChange={handleZoomChange}
        databasePath={currentWorkspace?.databasePath}
        workspaceId={currentWorkspace?.id}
        vimNavigationEnabled={vimEnabled}
        onVimNavigationChange={handleVimNavigationChange}
        updateCheckEnabled={updateCheckEnabled}
        onUpdateCheckEnabledChange={handleUpdateCheckEnabledChange}
        updateCheckFrequency={updateCheckFrequency}
        onUpdateCheckFrequencyChange={handleUpdateCheckFrequencyChange}
        updateAvailable={updateAvailable}
        updateChecking={updateChecking}
        updateCheckError={updateCheckError}
        onCheckForUpdates={checkForUpdates}
        onOpenUpdateDialog={() => setUpdateDialogOpen(true)}
        initialTab={settingsInitialTab}
        onCustomStatusesChanged={refreshAvailableStatuses}
      />

      {updateAvailable && (
        <UpdateDialog
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          updateInfo={updateAvailable}
          onDismiss={dismissUpdate}
          currentVersion={
            showRcVersion
              ? import.meta.env.VITE_BUILD_TAG || import.meta.env.VITE_APP_VERSION || "0.0.0"
              : import.meta.env.VITE_APP_VERSION || "0.0.0"
          }
        />
      )}

      <AlertDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && !isDeleting && setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this item?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The item will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              autoFocus
              disabled={isDeleting}
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={(e) => {
                e.preventDefault()
                if (deleteConfirmId) {
                  handleDelete(deleteConfirmId)
                }
              }}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Epic close/archive confirmation dialog (warns about open children) */}
      <AlertDialog
        open={!!epicCloseConfirm}
        onOpenChange={(open) => !open && setEpicCloseConfirm(null)}
      >
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {epicCloseConfirm?.action === "close" ? "Close" : "Archive"} epic with open children?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  <span className="font-medium text-foreground">{epicCloseConfirm?.epicTitle}</span>{" "}
                  has {epicCloseConfirm?.openChildren.length} open{" "}
                  {epicCloseConfirm?.openChildren.length === 1 ? "child" : "children"} that will
                  lose their grouping:
                </p>
                <ul className="max-h-40 overflow-y-auto space-y-1 text-sm">
                  {epicCloseConfirm?.openChildren.map((child) => (
                    <li
                      key={child.id}
                      className="flex items-start gap-2 px-2 py-1 rounded bg-muted/30"
                    >
                      <span className="text-muted-foreground font-mono text-xs shrink-0 mt-0.5">
                        {child.id}
                      </span>
                      <span>{child.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-muted hover:bg-muted/80 text-foreground"
              onClick={handleEpicCloseOnly}
            >
              {epicCloseConfirm?.action === "close" ? "Close" : "Archive"} epic only
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700"
              onClick={handleEpicCloseWithChildren}
            >
              {epicCloseConfirm?.action === "close" ? "Close" : "Archive"} children too
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Active workspace removal confirmation */}
      <AlertDialog
        open={!!removeConfirm}
        onOpenChange={(open) => !open && !removingWorkspaceId && setRemoveConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove active workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{removeConfirm?.name}&rdquo; is the workspace you&apos;re currently viewing.
              Removing it will unregister it from the selector. Your .beads/ data will not be
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!removingWorkspaceId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!removingWorkspaceId}
              onClick={() => {
                if (removeConfirm) {
                  doRemoveWorkspace(removeConfirm)
                }
              }}
            >
              {removingWorkspaceId && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {removingWorkspaceId ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DevConsole
        open={devConsole.open}
        activeTab={devConsole.activeTab}
        filter={devConsole.filter}
        height={devConsole.height}
        filteredCommands={devConsole.filteredCommands}
        filteredEvents={devConsole.filteredEvents}
        showHeartbeats={devConsole.showHeartbeats}
        dbPath={currentWorkspace?.databasePath}
        onToggle={devConsole.toggle}
        onClose={devConsole.close}
        onSetActiveTab={devConsole.setActiveTab}
        onSetFilter={devConsole.setFilter}
        onSetHeight={devConsole.setHeight}
        onClearCommands={devConsole.clearCommands}
        onClearEvents={devConsole.clearEvents}
        onToggleHeartbeats={devConsole.toggleHeartbeats}
        onExecuteCommand={handleExecuteCommand}
      />
    </div>
  )
}

// HomePage is the named export consumed by routes/index.tsx (TanStack Router).
// The default export keeps the original Next.js shape for any holdover
// references; both render the same tree.
export function HomePage() {
  return (
    <Suspense>
      <BeadsEpicsViewer />
    </Suspense>
  )
}

export default HomePage
