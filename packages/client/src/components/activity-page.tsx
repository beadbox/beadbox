import { useNavigate } from "@tanstack/react-router"
import { X } from "lucide-react"
import posthog from "posthog-js"
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useHasTrains } from "@/hooks/use-has-trains"
import { safeCapture } from "@/lib/posthog-safe"
import { useActiveWorkspace } from "../hooks/use-active-workspace"
import { useAppHealth } from "../hooks/use-app-health"
import { useCrossFilter } from "../hooks/use-cross-filter"
import { useDevConsole } from "../hooks/use-dev-console"
import { useDevConsoleTaps } from "../hooks/use-dev-console-taps"
import { useUpdateChecker } from "../hooks/use-update-checker"
import { deriveAgentStates, derivePipelineStages, toCanonicalStage } from "../lib/activity-utils"
import {
  getAnalyticsEnabled,
  getThemePreference,
  getUpdateCheckEnabled,
  getUpdateCheckFrequency,
  getVimNavigationEnabled,
  getZoomLevel,
  setZoomLevel as persistZoomLevel,
  setSelectedBead as setStoredSelectedBead,
  setThemePreference,
  setUpdateCheckEnabled,
  setUpdateCheckFrequency,
  setVimNavigationEnabled,
  type ThemeVariant,
  type UpdateCheckFrequency,
} from "../lib/local-storage"
import { rpc } from "../lib/rpc"
import { composePipelineChain } from "../lib/status-chain"
import { useSubscriptionChangeSignal } from "../lib/subscribe"
import type { ActivityEvent, PipelineStage, Workspace } from "../lib/types"
import { setWorkspaceCookie } from "../lib/workspace-cookie"
import { sessionPipeline } from "../lib/workspace-session-cache"
import { ActivityFeed } from "./activity-feed"
import { AgentStrip } from "./agent-strip"
import { DevConsole } from "./dev-console"
import { Header } from "./header"
import { PipelineFlow } from "./pipeline-flow"
import { SettingsDialog } from "./settings-dialog"
import { useWorkspaceGate } from "./startup-gate"
import { Badge } from "./ui/badge"
import { UpdateDialog } from "./update-dialog"

const PIPELINE_CACHE_MS = 30_000 // 30 seconds

function ActivityViewer() {
  const { workspaces: initialWorkspaces } = useWorkspaceGate()
  const navigate = useNavigate()
  // bb-93xp: useBdHealth no longer exposes reportBdError / reportWsReconnected
  // (the BdErrorBanner was removed). AppHealth setDegraded/setHealthy below
  // still drives the toast/badge surface for real bd failures.
  const [workspaces] = useState<Workspace[]>(initialWorkspaces)
  // Cookie-resolved active workspace: the rail can switch projects without
  // remounting this route, so the resolution has to be subscribed.
  const [currentWorkspace, setCurrentWorkspace] = useActiveWorkspace(workspaces)
  const hasTrains = useHasTrains(currentWorkspace?.id)
  const [loadingWorkspaceId, setLoadingWorkspaceId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  // Manual refresh signal (handleRefresh below) + subscription-driven signal
  // (bb-hj80 — fixes stale auto-update from bb-90zz.3). Combined as a sum so
  // the existing ActivityFeed/pipeline useEffect deps on changeSignal still
  // fire on every bump, regardless of source.
  const [manualRefreshSignal, setManualRefreshSignal] = useState(0)
  const subscriptionSignal = useSubscriptionChangeSignal()
  const changeSignal = manualRefreshSignal + subscriptionSignal
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Shared event state (lifted from ActivityFeed via onEventsChange callback)
  const [events, setEvents] = useState<ActivityEvent[]>([])

  // Loading states
  const [eventsLoading, setEventsLoading] = useState(true)
  const eventsLoadedOnceRef = useRef(false)
  const [pipelineLoading, setPipelineLoading] = useState(true)

  // Agent focus mode (toggled by 'a' key)
  const [agentFocusMode, setAgentFocusMode] = useState(false)
  const [focusedAgentIndex, setFocusedAgentIndex] = useState(0)

  // Cross-filter state shared across all 3 layers
  const {
    filter: crossFilter,
    setAgentFilter,
    setStageFilter,
    setBeadFilter,
    clearFilter,
    isFiltered,
  } = useCrossFilter()

  // Pipeline snapshot state
  const [stages, setStages] = useState<PipelineStage[]>([])
  const pipelineFetchedAtRef = useRef<number>(0)
  const [beadStatusMap, setBeadStatusMap] = useState<Map<string, string>>(new Map())

  // beadbox-8k3: workspace's custom status chain, derived from
  // rpc.beads.getAvailableStatuses (core + custom flat) → filter core out.
  // The pipeline-card tile composition is OPEN/IN_PROGRESS/<chain>/CLOSED
  // per pm/spec.md §4.9; the chain state lives here so the activity page
  // can re-fetch on subscription events without depending on the
  // home-page lifecycle hook.
  const [customStatusChain, setCustomStatusChain] = useState<string[]>([])
  const pipelineChain = useMemo(() => composePipelineChain(customStatusChain), [customStatusChain])

  // Settings and app-level state
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeVariant>("gray")
  const [zoomLevel, setZoomLevelState] = useState(100)
  const isTauriRef = useRef(false)
  const [vimEnabled, setVimEnabledState] = useState(true)
  const [updateCheckEnabled, setUpdateCheckEnabledState] = useState(true)
  const [updateCheckFrequency, setUpdateCheckFrequencyState] =
    useState<UpdateCheckFrequency>(3600000)
  const { health: appHealth, setHealthy, setDegraded } = useAppHealth()
  const [showRcVersion, setShowRcVersion] = useState(false)

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

  // Track the workspace mode present when this page mounts.
  const initialWorkspaceModeRef = useRef(currentWorkspace?.mode || "unknown")
  useEffect(() => {
    if (getAnalyticsEnabled()) {
      safeCapture("app_activity_viewed", {
        workspace_mode: initialWorkspaceModeRef.current,
      })
    }
  }, [])

  // Scroll depth tracking for activity feed engagement
  const scrollMilestonesRef = useRef(new Set<number>())

  const handleFeedScroll = useCallback(
    (e: React.UIEvent<HTMLElement>) => {
      if (!getAnalyticsEnabled()) return
      const el = e.currentTarget
      const scrollable = el.scrollHeight - el.clientHeight
      if (scrollable <= 0) return
      const scrollPct = Math.round((el.scrollTop / scrollable) * 100)
      for (const milestone of [25, 50, 75, 100]) {
        if (scrollPct >= milestone && !scrollMilestonesRef.current.has(milestone)) {
          scrollMilestonesRef.current.add(milestone)
          safeCapture("app_activity_scrolled", {
            scroll_depth: milestone,
            event_count: events.length,
          })
        }
      }
    },
    [events.length],
  )

  // Load preferences on mount
  useEffect(() => {
    setTheme(getThemePreference())
    setVimEnabledState(getVimNavigationEnabled())
    setUpdateCheckEnabledState(getUpdateCheckEnabled())
    setUpdateCheckFrequencyState(getUpdateCheckFrequency())
    isTauriRef.current = !!(window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    if (isTauriRef.current) {
      setZoomLevelState(getZoomLevel())
    }
    try {
      setShowRcVersion(!!posthog.isFeatureEnabled("use-private-update-repo"))
    } catch {
      /* PostHog not ready */
    }
    posthog.onFeatureFlags?.(() => {
      try {
        setShowRcVersion(!!posthog.isFeatureEnabled("use-private-update-repo"))
      } catch {
        /* ignore */
      }
    })
  }, [])

  // Apply theme classes to <html>
  useEffect(() => {
    const el = document.documentElement
    el.classList.add("dark")
    el.classList.remove("theme-gray", "theme-green")
    if (theme === "gray") el.classList.add("theme-gray")
    if (theme === "green") el.classList.add("theme-green")
  }, [theme])

  // Apply zoom level to document (Tauri only)
  useEffect(() => {
    if (!isTauriRef.current) return
    document.documentElement.style.zoom = `${zoomLevel}%`
  }, [zoomLevel])

  const handleThemeChange = (next: ThemeVariant) => {
    setTheme(next)
    setThemePreference(next)
  }

  const handleZoomChange = useCallback((level: number) => {
    const clamped = Math.max(50, Math.min(200, level))
    setZoomLevelState(clamped)
    persistZoomLevel(clamped)
  }, [])

  const handleVimNavigationChange = useCallback((enabled: boolean) => {
    setVimEnabledState(enabled)
    setVimNavigationEnabled(enabled)
  }, [])

  const handleUpdateCheckEnabledChange = useCallback((enabled: boolean) => {
    setUpdateCheckEnabledState(enabled)
    setUpdateCheckEnabled(enabled)
  }, [])

  const handleUpdateCheckFrequencyChange = useCallback((frequency: UpdateCheckFrequency) => {
    setUpdateCheckFrequencyState(frequency)
    setUpdateCheckFrequency(frequency)
  }, [])

  // Extract primitives for React Compiler compatibility
  const currentWorkspaceId = currentWorkspace?.id
  const databasePath = currentWorkspace?.databasePath

  const handleWorkspaceChange = useCallback(
    (workspace: Workspace) => {
      if (workspace.id === currentWorkspaceId) return
      setLoadingWorkspaceId(workspace.id)
      setWorkspaceCookie(workspace.id)
      setHealthy()
      startTransition(() => {
        setCurrentWorkspace(workspace)
        setLoadingWorkspaceId(null)
      })
    },
    [currentWorkspaceId, setHealthy, setCurrentWorkspace],
  )
  // Reserved for the workspace switcher in <Header>; legacy code passed it
  // through Header props that this page port doesn't yet wire up.
  void handleWorkspaceChange

  // bb-pgb0.1: deleted dev-console <-> WebSocket ref-bridge wiring +
  // useState shims for wsConnected/pollingHealthy/requestBuffer per
  // pm/systemdesign.md §3.3 (each retired field documented; no v0.25
  // equivalent). Dev-console event delivery comes from setRpcTap +
  // setSubscriptionTap in lib/rpc.ts + lib/subscribe.ts via
  // useDevConsoleTaps below; the refs/handlers here had no callers
  // (the local wsConnected/pollingHealthy useState shims were
  // hardcoded `true`/`null` so the disconnect/degrade branches below
  // were already dead — now deleted with their consumers).
  const devConsole = useDevConsole({ dbPath: currentWorkspace?.databasePath })

  useDevConsoleTaps(devConsole)

  const handleExecuteCommand = useCallback(
    async (args: string[]) => {
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

  // bb-pgb0.1: deleted the wsConnected disconnect-degrade effect + the
  // pollingHealthy degrade/recover effect. Both keyed on the deleted
  // useState shims (hardcoded `true` / `null`) so neither branch ever
  // fired. Per pm/systemdesign.md §3.3, AppHealth degrade transitions
  // are owned by lib/subscribe.ts's polling_error / recovered handlers.

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    setManualRefreshSignal((s) => s + 1)
    // Brief visual feedback for refresh
    setTimeout(() => setIsRefreshing(false), 500)
  }, [])

  // Fetch pipeline snapshot (bd list --json), with a per-workspace session
  // cache. The freshness stamp lives in the cache rather than in a ref so it
  // survives this route unmounting on every navigation away — otherwise the
  // card refetched and flashed its spinner on each return trip.
  //
  // The TTL only applies to a signal-less mount (beadbox-11i). A bd change
  // signal — a real write, or the synthetic one a subscription emits when it
  // (re)starts on a workspace switch — always refetches: the snapshot may
  // predate an edit made from the CLI while this workspace was not the one
  // being watched, and the cache must never outrank bd's own signal. The
  // cached snapshot is still painted first so the card does not flash.
  const fetchPipelineSnapshot = useCallback(
    async (reason: "mount" | "signal") => {
      if (!databasePath) return
      const now = Date.now()
      const cached = sessionPipeline.get(currentWorkspaceId)
      if (cached) {
        setStages(cached.stages)
        setBeadStatusMap(cached.beadStatuses)
        setPipelineLoading(false)
        if (reason === "mount" && now - cached.fetchedAt < PIPELINE_CACHE_MS) return
      }

      try {
        const result = await rpc.activity.listBeadsByStatus(currentWorkspaceId)
        // beadbox-8k3: pass the workspace's pipeline chain so the tile set
        // reflects status.custom per pm/spec.md §4.9. Empty status.custom →
        // just the 3 built-in tiles via composePipelineChain.
        const derived = derivePipelineStages(result.beads, pipelineChain)
        setStages(derived)
        pipelineFetchedAtRef.current = now

        // Build bead -> canonical pipeline stage map for cross-filter lookups.
        // Backlog tile dropped per §4.9 strict-spec — P4 beads with
        // status=open now map to the OPEN stage rather than a synthetic
        // backlog stage. Priority filtering still lives in the filter-bar.
        const statusMap = new Map<string, string>()
        for (const bead of result.beads) {
          statusMap.set(bead.id, toCanonicalStage(bead.status))
        }
        setBeadStatusMap(statusMap)
        sessionPipeline.set(currentWorkspaceId, {
          stages: derived,
          beadStatuses: statusMap,
          fetchedAt: now,
        })

        setHealthy()
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        // bb-93xp: bd-missing errors used to fire reportBdError → yellow
        // banner. The banner was removed; the failure still surfaces via
        // the action's own error path (toast / inline message). No
        // additional UI hook needed here.
        if (
          currentWorkspace?.mode === "server" &&
          (msg.includes("ECONNREFUSED") ||
            msg.includes("ETIMEDOUT") ||
            msg.includes("connection refused") ||
            msg.includes("timeout") ||
            msg.includes("unreachable") ||
            msg.includes("circuit breaker") ||
            msg.includes("not found on Dolt server"))
        ) {
          setDegraded("Dolt server unreachable")
        }
      }
      setPipelineLoading(false)
    },
    [databasePath, currentWorkspaceId, currentWorkspace, setDegraded, pipelineChain, setHealthy],
  )

  // beadbox-8k3: load the workspace's custom status chain so the pipeline
  // tile composition reflects status.custom. Uses the same RPC eng1's
  // beadbox-3qo wired (`rpc.beads.getCustomStatusList` returns just the
  // ordered custom chain, no core lifecycle statuses to filter). Fetched
  // on workspace change + on subscription events (so a `bd config set
  // status.custom ...` CLI write from outside reflects within ~2s per
  // spec §5).
  useEffect(() => {
    void changeSignal
    if (!databasePath) return
    let cancelled = false
    rpc.beads
      .getCustomStatusList(currentWorkspace?.id)
      .then((chain) => {
        if (cancelled) return
        setCustomStatusChain(chain)
      })
      .catch(() => {
        // On error, fall back to empty chain (just the 3 built-in tiles).
        // status.custom can also be legitimately empty; same user-visible
        // shape.
        if (!cancelled) setCustomStatusChain([])
      })
    return () => {
      cancelled = true
    }
  }, [databasePath, changeSignal, currentWorkspace?.id])

  // Initial pipeline fetch (served from the session cache inside the TTL)
  useEffect(() => {
    fetchPipelineSnapshot("mount")
  }, [fetchPipelineSnapshot])

  // Re-fetch pipeline on bd change signals — bypasses the cache TTL.
  useEffect(() => {
    if (changeSignal > 0) {
      fetchPipelineSnapshot("signal")
    }
  }, [changeSignal, fetchPipelineSnapshot])

  // Derive agent states from shared events
  const agents = useMemo(() => deriveAgentStates(events), [events])

  // Count beads moved today from status events
  const beadsMovedToday = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayMs = today.getTime()
    let count = 0
    for (const e of events) {
      if (e.type === "status" && new Date(e.timestamp).getTime() >= todayMs) {
        count++
      }
    }
    return count
  }, [events])

  // Callback: ActivityFeed reports events changes
  const handleEventsChange = useCallback((newEvents: ActivityEvent[]) => {
    setEvents(newEvents)
    if (!eventsLoadedOnceRef.current) {
      eventsLoadedOnceRef.current = true
      setEventsLoading(false)
    }
  }, [])

  // Toggle handlers: clicking the same agent/stage again clears the filter
  const handleAgentClick = useCallback(
    (agentName: string) => {
      if (crossFilter.type === "agent" && crossFilter.value === agentName) {
        clearFilter()
      } else {
        setAgentFilter(agentName)
      }
    },
    [crossFilter, clearFilter, setAgentFilter],
  )

  const handleStageClick = useCallback(
    (stageName: string) => {
      if (crossFilter.type === "stage" && crossFilter.value === stageName) {
        clearFilter()
      } else {
        setStageFilter(stageName)
      }
    },
    [crossFilter, clearFilter, setStageFilter],
  )

  const handleBeadClick = useCallback(
    (beadId: string) => {
      if (crossFilter.type === "bead" && crossFilter.value === beadId) {
        clearFilter()
      } else {
        setBeadFilter(beadId)
      }
    },
    [crossFilter, clearFilter, setBeadFilter],
  )

  // Navigate from feed item to bead detail on main page.
  const handleBeadNavigate = useCallback(
    async (beadId: string): Promise<boolean> => {
      const exists = await rpc.beads.checkBeadExists(beadId, currentWorkspace?.id)
      if (!exists) return false

      setStoredSelectedBead(beadId)
      sessionStorage.setItem("beadbox-nav-from-activity", "true")
      navigate({ to: "/" })
      return true
    },
    [currentWorkspace?.id, navigate],
  )

  // Cross-filter chip label
  const filterChipLabel = useMemo(() => {
    if (!isFiltered) return null
    switch (crossFilter.type) {
      case "agent":
        return `Showing: ${crossFilter.value}'s events`
      case "stage":
        return `Showing: ${crossFilter.value} beads`
      case "bead":
        return `Showing: ${crossFilter.value} events`
      default:
        return null
    }
  }, [crossFilter, isFiltered])

  // Keyboard shortcuts (placed after all callbacks so deps are in scope)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+, opens settings (works from anywhere, including inputs)
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSettingsOpen(true)
        return
      }

      // Cmd+1/Cmd+2/Cmd+3: view switching (always active)
      if (
        (e.metaKey || e.ctrlKey) &&
        (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4")
      ) {
        e.preventDefault()
        if (e.key === "1") {
          navigate({ to: "/" })
        }
        if (e.key === "3") {
          navigate({ to: "/formulas" as never })
        }
        if (e.key === "4" && hasTrains) {
          navigate({ to: "/trains" as never })
        }
        return
      }

      // Cmd/Ctrl+R or F5: Refresh data (prevent browser reload)
      if ((e.key === "r" && (e.metaKey || e.ctrlKey) && !e.shiftKey) || e.key === "F5") {
        e.preventDefault()
        handleRefresh()
        return
      }

      // Zoom shortcuts (Tauri only, work from anywhere including inputs)
      if (isTauriRef.current && (e.metaKey || e.ctrlKey)) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault()
          setZoomLevelState((prev) => {
            const next = Math.min(200, prev + 10)
            persistZoomLevel(next)
            return next
          })
          return
        }
        if (e.key === "-") {
          e.preventDefault()
          setZoomLevelState((prev) => {
            const next = Math.max(50, prev - 10)
            persistZoomLevel(next)
            return next
          })
          return
        }
        if (e.key === "0") {
          e.preventDefault()
          setZoomLevelState(100)
          persistZoomLevel(100)
          return
        }
      }

      // Skip all non-modifier shortcuts when typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      // Skip navigation keys when settings dialog is open
      if (settingsOpen) {
        return
      }

      // Escape: exit agent focus mode, or clear cross-filter
      if (e.key === "Escape") {
        if (agentFocusMode) {
          setAgentFocusMode(false)
          return
        }
        if (isFiltered) {
          clearFilter()
        }
        return
      }

      // Keys 1-N: cross-filter to pipeline stage by index in the
      // workspace's composed chain. beadbox-8k3: previously bound to the
      // hardcoded CANONICAL_STAGES; now dynamically scoped to the actual
      // visible tile set. If the chain is shorter than 5 (e.g., empty
      // status.custom → 3 tiles), keys past the chain length are no-ops.
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const stageIndex = parseInt(e.key, 10) - 1
        if (stageIndex >= 0 && stageIndex < pipelineChain.length) {
          handleStageClick(pipelineChain[stageIndex])
          if (agentFocusMode) setAgentFocusMode(false)
          return
        }
      }

      // 'a': toggle agent strip focus mode
      if (e.key === "a" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setAgentFocusMode((prev) => {
          if (!prev) setFocusedAgentIndex(0)
          return !prev
        })
        return
      }

      // Agent focus mode navigation
      if (agentFocusMode) {
        if (e.key === "ArrowRight" || e.key === "l") {
          e.preventDefault()
          setFocusedAgentIndex((prev) => Math.min(prev + 1, agents.length - 1))
          return
        }
        if (e.key === "ArrowLeft" || e.key === "h") {
          e.preventDefault()
          setFocusedAgentIndex((prev) => Math.max(prev - 1, 0))
          return
        }
        if (e.key === "Enter") {
          if (agents.length > 0 && agents[focusedAgentIndex]) {
            handleAgentClick(agents[focusedAgentIndex].name)
          }
          return
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    navigate,
    hasTrains,
    isFiltered,
    clearFilter,
    agentFocusMode,
    focusedAgentIndex,
    agents,
    handleStageClick,
    handleAgentClick,
    handleRefresh,
    settingsOpen,
    pipelineChain,
  ])

  // Exit agent focus mode when agents list changes and index is out of bounds
  useEffect(() => {
    if (agentFocusMode && agents.length > 0 && focusedAgentIndex >= agents.length) {
      setFocusedAgentIndex(agents.length - 1)
    }
  }, [agentFocusMode, agents.length, focusedAgentIndex])

  return (
    <div className="h-full flex flex-col bg-background safe-area-inset">
      <Header
        currentWorkspace={
          currentWorkspace || { id: "", name: "Loading...", mode: "embedded" as const }
        }
        loadingWorkspaceId={loadingWorkspaceId}
        isPending={isPending}
        isRefreshing={isRefreshing}
        appHealth={appHealth}
        onRefresh={handleRefresh}
        updateAvailable={updateAvailable}
        onUpdateClick={() => setUpdateDialogOpen(true)}
        versionLabel={
          showRcVersion
            ? `v${import.meta.env.VITE_BUILD_TAG || import.meta.env.VITE_APP_VERSION || "0.0.0"}`
            : undefined
        }
        onSettingsOpen={() => setSettingsOpen(true)}
      />

      <main
        className="flex-1 flex flex-col min-h-0 overflow-y-auto"
        onScroll={handleFeedScroll}
        style={devConsole.open ? { marginBottom: devConsole.height } : undefined}
      >
        {currentWorkspace && (
          <>
            {/* Layer 1: Agent Status Strip */}
            <div className="px-4 pt-4 pb-2">
              <AgentStrip
                agents={agents}
                crossFilter={crossFilter}
                onAgentClick={handleAgentClick}
                loading={eventsLoading}
                focusedIndex={agentFocusMode ? focusedAgentIndex : null}
              />
            </div>

            {/* Cross-filter chip */}
            {filterChipLabel && (
              <div className="px-4 pb-2">
                <Badge
                  variant="secondary"
                  className="inline-flex items-center gap-1.5 text-xs bg-blue-500/15 text-blue-400 border-blue-500/30 hover:bg-blue-500/25"
                >
                  {filterChipLabel}
                  <button
                    onClick={clearFilter}
                    className="hover:text-blue-200 transition-colors"
                    aria-label="Clear cross-filter"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              </div>
            )}

            {/* Layer 2: Pipeline Flow */}
            <div className="px-4 pb-3">
              <PipelineFlow
                stages={stages}
                crossFilter={crossFilter}
                onStageClick={handleStageClick}
                onBeadClick={handleBeadClick}
                beadsMovedToday={beadsMovedToday}
                loading={pipelineLoading}
              />
            </div>

            {/* Layer 3: Event Feed */}
            <ActivityFeed
              dbPath={currentWorkspace.databasePath}
              workspaceId={currentWorkspace.id}
              changeSignal={changeSignal}
              onBeadNavigate={handleBeadNavigate}
              crossFilter={crossFilter}
              onEventsChange={handleEventsChange}
              beadStatusMap={beadStatusMap}
              onClearCrossFilter={clearFilter}
            />
          </>
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

export function ActivityPage() {
  return (
    <Suspense>
      <ActivityViewer />
    </Suspense>
  )
}
