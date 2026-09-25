import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { AppHealth } from "@/hooks/use-app-health"
import { useWorkspaceLabelSync } from "@/hooks/use-workspace-label-sync"
import type { BdLoadError } from "@/lib/bd-error"
import { captureServerActionFailed } from "@/lib/capture-action-failed"
import { collectAllBeadsFromEpics, countAllBeads } from "@/lib/epic-tree-utils"
import { getAnalyticsEnabled, getReadState, initializeReadState } from "@/lib/local-storage"
import { toastError } from "@/lib/notifications"
import { safeCapture } from "@/lib/posthog-safe"
import { rpc } from "@/lib/rpc"
import type { Epic, ReadState, Workspace } from "@/lib/types"
import {
  type BeadboxLoadEpicsEntry,
  type BeadboxLoadEpicsPhase,
  ensureBeadboxStamp,
} from "@/lib/window-globals"
import { unregisterWorkspace } from "@/lib/workspace-actions"
import {
  getWorkspaceCookie,
  setWorkspaceCookie,
  subscribeWorkspaceCookie,
} from "@/lib/workspace-cookie"
import { sessionEpics } from "@/lib/workspace-session-cache"

// beadbox-jk7 / cascade-9 diagnostic: ring-buffer push for loadEpics lifecycle
// transitions, capped at 32 entries. Lives next to the consumer so the trim
// constant doesn't grow into a config knob — diagnostic-only, removed when
// cascade-9 closes.
const LOAD_EPICS_LOG_CAP = 32
function recordLoadEpicsPhase(
  phase: BeadboxLoadEpicsPhase,
  gen: number,
  dbPath: string | null,
  extras: Partial<Pick<BeadboxLoadEpicsEntry, "epicsLength" | "errorMessage">> = {},
): void {
  const stamp = ensureBeadboxStamp()
  if (!stamp) return
  stamp.loadEpics ??= []
  stamp.loadEpics.push({ ts: new Date().toISOString(), phase, gen, dbPath, ...extras })
  if (stamp.loadEpics.length > LOAD_EPICS_LOG_CAP) {
    stamp.loadEpics.splice(0, stamp.loadEpics.length - LOAD_EPICS_LOG_CAP)
  }
}

// Handlers are called through the `rpc` proxy at the callsite, never captured
// at module load: `const f = rpc.ns.method` freezes whichever transport was
// installed when this module was first evaluated, which pins the browser-dev
// stub (and defeats the _setRpc test seam).

// UX threshold for "taking longer than expected" feedback + app_workspace_load_timeout
// telemetry. Paired with app_workspace_load_succeeded on success, this lets us measure
// the real load-time distribution instead of conflating "slow but working" with stuck.
const WORKSPACE_LOAD_TIMEOUT_MS = 15_000
const systemIssuesKey = (id: string) => `beadbox:system-issues:${id}`
const treeCacheKey = (id: string | undefined, includeSystem: boolean) =>
  id ? `${id}:${includeSystem ? "all" : "normal"}` : undefined

function readSystemIssues(id: string | undefined): boolean {
  if (!id || typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(systemIssuesKey(id)) === "true"
  } catch {
    return false
  }
}

function modeForWorkspace(id: string | undefined, sessionModes: Record<string, boolean>): boolean {
  return id ? (sessionModes[id] ?? readSystemIssues(id)) : false
}

function isHealthReady(healthRef: React.RefObject<AppHealth>): boolean {
  return healthRef.current.status === "healthy"
}

function includeSystemForWorkspace(
  workspace: Workspace | null,
  savedModes: Record<string, boolean>,
  sessionModes: Record<string, boolean>,
): boolean {
  if (!workspace) return false
  return savedModes[workspace.id] ?? modeForWorkspace(workspace.id, sessionModes)
}

type TypeCatalog = {
  workspaceId: string
  status: "loading" | "retrying" | "ready" | "error"
  message?: string
}

function typeCatalogState(catalog: TypeCatalog | null, workspaceId: string | undefined) {
  const active = catalog?.workspaceId === workspaceId ? catalog : null
  return {
    ready: active?.status === "ready",
    retrying: active?.status === "retrying",
    error:
      active && (active.status === "error" || active.status === "retrying")
        ? (active.message ?? "Could not load issue types")
        : null,
  }
}

interface UseWorkspaceLifecycleOpts {
  initialWorkspaces: Workspace[]
  appHealth: AppHealth
  appHealthRef: React.RefObject<AppHealth>
  setHealthy: () => void
  setDegraded: (reason: string) => void
  setHealthError: (msg: string, error: BdLoadError, autoRetry?: boolean) => void
  setFatal: (msg: string, error: BdLoadError) => void
}

export function useWorkspaceLifecycle(opts: UseWorkspaceLifecycleOpts) {
  const { initialWorkspaces, appHealth, appHealthRef, setHealthy, setHealthError, setFatal } = opts

  const navigate = useNavigate()

  const [workspaces, setWorkspaces] = useState<Workspace[]>(initialWorkspaces)
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null)
  const [systemIssuesByWorkspace, setSystemIssuesByWorkspace] = useState<Record<string, boolean>>(
    {},
  )
  const systemIssuesRef = useRef<Record<string, boolean>>({})
  const workspaceId = currentWorkspace?.id
  const workspaceDbPath = currentWorkspace?.databasePath
  const includeSystem = includeSystemForWorkspace(
    currentWorkspace,
    systemIssuesByWorkspace,
    systemIssuesRef.current,
  )
  const setIncludeSystem = useCallback(
    (enabled: boolean) => {
      if (!workspaceId) return
      try {
        localStorage.setItem(systemIssuesKey(workspaceId), String(enabled))
      } catch {
        // Keep this session's setting even when WebView storage is unavailable.
      }
      loadGenRef.current++
      const cached = sessionEpics.get(treeCacheKey(workspaceId, enabled))
      epicsWorkspaceIdRef.current = cached ? (treeCacheKey(workspaceId, enabled) ?? null) : null
      setEpics(cached ?? [])
      hasExistingDataRef.current = !!cached
      systemIssuesRef.current[workspaceId] = enabled
      setSystemIssuesByWorkspace((current) => ({ ...current, [workspaceId]: enabled }))
    },
    [workspaceId],
  )
  const [epics, setEpics] = useState<Epic[]>([])
  const [availableTypes, setAvailableTypes] = useState<string[]>([])
  const [typeCatalog, setTypeCatalog] = useState<TypeCatalog | null>(null)
  const {
    ready: typeCatalogReady,
    retrying: typeCatalogRetrying,
    error: typeCatalogError,
  } = typeCatalogState(typeCatalog, currentWorkspace?.id)
  const typeCatalogRequestRef = useRef(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [loadingWorkspaceId, setLoadingWorkspaceId] = useState<string | null>(null)

  // Concurrency guard: prevent overlapping loads from stacking
  const loadInProgressRef = useRef(false)
  // Generation counter: monotonically increasing. Each loadEpics call captures
  // the current generation at start. On completion, stale loads (gen mismatch)
  // discard their results silently. Prevents race conditions during rapid
  // workspace switches where an old load's finally block corrupts shared refs.
  const loadGenRef = useRef(0)
  // Timestamp of last completed load; suppresses redundant WS-triggered reloads
  // that fire within 2s (e.g. the first poll after WS connects)
  const lastLoadCompletedRef = useRef(0)
  // Deferred re-check: when a WS notification arrives during the cooldown window,
  // schedule a retry after the cooldown expires instead of silently dropping it.
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasExistingDataRef = useRef(false)
  // Workspace the tree in `epics` was loaded for. Guards the session-cache
  // mirror below: `epics` and `currentWorkspace` are two states that change on
  // different commits during a switch.
  const epicsWorkspaceIdRef = useRef<string | null>(null)
  // Per-attempt timer origin: reset each time loadEpics fires (including auto-retries).
  // Used by app_workspace_load_{succeeded,timeout}.elapsed_ms to measure THIS attempt.
  const loadStartTimeRef = useRef(0)
  // Per-switch timer origin: set once when a workspace switch begins and NOT reset by
  // auto-retries. Used by app_workspace_load_{succeeded,timeout}.initial_switch_ms to
  // measure the full "how slow was this session" duration, even across retry attempts.
  // Key property for distinguishing "attempt is slow" from "user experience is slow."
  // bb-kr64 ports bb-0wpy follow-up (main 12fabb2).
  const switchStartTimeRef = useRef(0)

  const [isSlowLoad, setIsSlowLoad] = useState(false)

  // Auto-retry state for transient errors
  const [autoRetryCountdown, setAutoRetryCountdown] = useState<number | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const retryCountRef = useRef(0)

  // Flock contention: track sustained contention for the amber banner
  const [flockContention, setFlockContention] = useState(false)
  const [flockBanner, setFlockBanner] = useState(false)
  const flockStartRef = useRef<number | null>(null)
  const flockBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Workspace removal confirmation state (active workspace needs confirm)
  const [removeConfirm, setRemoveConfirm] = useState<Workspace | null>(null)
  // Track which workspace is currently being removed (prevents double-removal)
  const [removingWorkspaceId, setRemovingWorkspaceId] = useState<string | null>(null)

  // Read state for unread indicators
  const [readState, setReadStateLocal] = useState<ReadState>({})

  // Available statuses for the current workspace (core + custom)
  const [availableStatuses, setAvailableStatuses] = useState<string[]>([
    "open",
    "in_progress",
    "closed",
  ])

  // beadbox-3qo: ordered custom-status chain for the workflow advancement
  // button (pm/spec §4.3). Distinct from availableStatuses — that list
  // prepends core lifecycle statuses for the dropdown; this is the raw
  // ordered chain from `bd config get status.custom` used to derive the
  // single next-state advancement step.
  const [customStatusChain, setCustomStatusChain] = useState<string[]>([])

  // Analytics refs: track which events have fired to prevent duplicates
  const workspaceSourceRef = useRef<"auto" | "manual">("auto")
  const workspaceOpenedFiredRef = useRef<string | null>(null)
  const issuesEventFiredRef = useRef<string | null>(null)
  const timeoutFiredRef = useRef<string | null>(null)
  const loadStartedFiredRef = useRef(false)

  // Derive loadError from health for auto-retry logic and error display components
  const loadError =
    appHealth.status === "error" || appHealth.status === "fatal" ? appHealth.loadError : null

  // Fire app_workspace_load_started at hook mount time, BEFORE workspace
  // selection or any data fetching. This captures the "I'm alive" signal
  // for telemetry so we can measure the gap between app_workspace_switch
  // (fired on /workspaces click) and the lifecycle hook actually mounting
  // on page.tsx. Without this, users stuck before workspace_opened are
  // invisible to analytics (bb-g4sz). Fires once per hook instance.
  useEffect(() => {
    if (loadStartedFiredRef.current || !getAnalyticsEnabled()) return
    loadStartedFiredRef.current = true
    safeCapture("app_workspace_load_started", {
      initial_workspace_count: initialWorkspaces.length,
      cookie_present: !!getWorkspaceCookie(),
    })
  }, [initialWorkspaces.length])

  // Set initial workspace from props (already fetched by StartupGate)
  useEffect(() => {
    if (initialWorkspaces.length > 0 && !currentWorkspace) {
      const savedWorkspaceId = getWorkspaceCookie()
      const savedWorkspace = savedWorkspaceId
        ? initialWorkspaces.find((w) => w.id === savedWorkspaceId)
        : null
      const selected = savedWorkspace || initialWorkspaces[0]
      console.log(
        `[ws-debug-page] setting workspace: cookie=${savedWorkspaceId} selected.dbPath=${selected?.databasePath} selected.mode=${selected?.mode} workspaces=${initialWorkspaces.map((w) => w.databasePath).join(",")}`,
      )
      // Seed from the session cache on mount too, not just on an in-place
      // switch: this hook remounts whenever StartupGate re-runs its health
      // check (a workspace it has not verified yet, a retry, StrictMode's
      // double mount in dev), and a fresh instance would otherwise drop
      // back to the skeleton for a tree it already has.
      const selectedMode = modeForWorkspace(selected?.id, systemIssuesRef.current)
      const cached = sessionEpics.get(treeCacheKey(selected?.id, selectedMode))
      if (cached) {
        setEpics(cached)
        epicsWorkspaceIdRef.current = treeCacheKey(selected?.id, selectedMode) ?? null
        hasExistingDataRef.current = true
      }
      setCurrentWorkspace(selected)
    }
  }, [initialWorkspaces, currentWorkspace])

  // Adopt in-place workspace switches driven by the workspace rail.
  //
  // The rail lives outside StartupGate and switches by writing the cookie.
  // When the gate has already health-checked the target this session it
  // skips its re-check (no remount, no "Starting up..." screen), so this
  // listener is the only thing that notices. Refs keep it stable — it is
  // registered once and reads the latest state.
  const currentWorkspaceIdRef = useRef<string | null>(null)
  useEffect(() => {
    currentWorkspaceIdRef.current = currentWorkspace?.id ?? null
  }, [currentWorkspace?.id])
  const workspacesRef = useRef<Workspace[]>(initialWorkspaces)
  useEffect(() => {
    workspacesRef.current = workspaces
  }, [workspaces])
  const currentWorkspaceRef = useRef(currentWorkspace)
  useEffect(() => {
    currentWorkspaceRef.current = currentWorkspace
  }, [currentWorkspace])

  useEffect(
    () =>
      subscribeWorkspaceCookie(() => {
        const cookieId = getWorkspaceCookie()
        if (!cookieId || cookieId === currentWorkspaceIdRef.current) return
        const target = workspacesRef.current.find((w) => w.id === cookieId)
        // Unknown id: the gate is re-checking and will remount this hook
        // with a registry list that contains it.
        if (!target) return
        workspaceSourceRef.current = "manual"
        // Invalidate any in-flight load before the workspace changes: a
        // getEpics for the previous workspace that resolves in the gap
        // before loadEpics re-runs would otherwise pass its gen check and
        // publish the wrong tree.
        loadGenRef.current++
        setLoadingWorkspaceId(target.id)
        setCurrentWorkspace(target)
        setHealthy()
        // loadEpics only raises isLoading once its effect runs, one commit
        // later; without this the render in between shows the previous
        // workspace's tree under the new workspace's name.
        setIsLoading(true)
        // Paint the target workspace's last known tree straight away when we
        // have one; loadEpics then refreshes in the background. Without this
        // every switch drops back to the skeleton for the length of a bd +
        // Dolt round trip. hasExistingDataRef gates that skeleton (see
        // home-page's `isLoading && !hasExistingDataRef.current`).
        const targetMode = modeForWorkspace(target.id, systemIssuesRef.current)
        const cached = sessionEpics.get(treeCacheKey(target.id, targetMode))
        epicsWorkspaceIdRef.current = cached ? (treeCacheKey(target.id, targetMode) ?? null) : null
        if (cached) {
          setEpics(cached)
          hasExistingDataRef.current = true
        } else {
          setEpics([])
          hasExistingDataRef.current = false
        }
      }),
    [setHealthy],
  )

  // Rail renames / icon changes are registry writes; patch the copies this
  // hook holds so the Header updates without a workspace list refetch.
  useWorkspaceLabelSync({ setActive: setCurrentWorkspace, setList: setWorkspaces })

  // Mirror the rendered tree into the session cache, so a switch away and
  // back paints the post-edit state rather than resurrecting beads that
  // were closed, archived or deleted since the load. Guarded by the path
  // the tree was loaded for: during a switch the state briefly still holds
  // the previous workspace's tree, and storing that under the new key
  // would turn a one-frame glitch into a persistent wrong-project paint.
  useEffect(() => {
    if (epicsWorkspaceIdRef.current !== treeCacheKey(currentWorkspace?.id, includeSystem)) return
    sessionEpics.set(treeCacheKey(currentWorkspace?.id, includeSystem), epics)
  }, [epics, currentWorkspace?.id, includeSystem])

  // Fire app_workspace_opened when a workspace STARTS loading (once per workspace.id)
  // This fires at load start so app_issues_rendered (which fires at load end) has
  // a meaningful elapsed time gap — enabling workspace load time measurement.
  useEffect(() => {
    if (!workspaceId || !isLoading || !getAnalyticsEnabled()) return
    if (workspaceOpenedFiredRef.current === workspaceId) return
    workspaceOpenedFiredRef.current = workspaceId
    // bb-kr64: anchor the "whole user experience" timer here — once per
    // workspace.id, never reset by auto-retries. Distinct from
    // loadStartTimeRef which resets per attempt.
    switchStartTimeRef.current = Date.now()

    safeCapture("app_workspace_opened", {
      workspace_count: workspaces.length,
      source: workspaceSourceRef.current,
    })

    // After first fire, subsequent workspace changes are manual
    workspaceSourceRef.current = "manual"
  }, [workspaceId, isLoading, workspaces.length])

  // Fire app_issues_rendered or app_empty_state_shown once per workspace load,
  // plus app_workspace_load_succeeded with elapsed_ms for load-time distribution
  // analysis (bb-0wpy). Shares the same timer origin (loadStartTimeRef) as
  // app_workspace_load_timeout, so the two events can be compared directly.
  useEffect(() => {
    if (!workspaceId || isLoading || !getAnalyticsEnabled()) return
    if (issuesEventFiredRef.current === workspaceId) return
    issuesEventFiredRef.current = workspaceId

    const issueCount = countAllBeads(epics)
    if (issueCount > 0) {
      safeCapture("app_issues_rendered", {
        issue_count: issueCount,
        epic_count: epics.length,
        workspace_count: workspaces.length,
      })
    } else {
      safeCapture("app_empty_state_shown", {
        workspace_count: workspaces.length,
      })
    }

    // had_timeout flag distinguishes "fast load" from "slow but eventually succeeded"
    // — the key signal for tuning WORKSPACE_LOAD_TIMEOUT_MS.
    // bb-kr64: elapsed_ms measures THIS attempt (resets on auto-retry).
    // initial_switch_ms measures the whole user experience since workspace
    // switch (does not reset on retry) so dashboards can see session-level
    // latency. Null when switchStartTimeRef hasn't been set yet (e.g. if a
    // timeout fires before app_workspace_opened).
    const origin = loadStartTimeRef.current
    if (origin > 0) {
      const switchOrigin = switchStartTimeRef.current
      safeCapture("app_workspace_load_succeeded", {
        elapsed_ms: Date.now() - origin,
        initial_switch_ms: switchOrigin > 0 ? Date.now() - switchOrigin : null,
        issue_count: issueCount,
        workspace_count: workspaces.length,
        had_timeout: timeoutFiredRef.current === workspaceId,
      })
    }
  }, [workspaceId, isLoading, epics, workspaces.length])

  // Fire app_workspace_load_timeout if issues haven't rendered WORKSPACE_LOAD_TIMEOUT_MS
  // after workspace open. When the timeout fires and no error has been set yet,
  // synthesize a server-unreachable error so the user sees WorkspaceErrorScreen
  // with an actionable fix command.
  // Threshold raised 10s -> 15s per bb-0zmz: cold bd + Dolt spinup on first-run
  // Mac workspaces legitimately takes >10s; paired with app_workspace_load_succeeded
  // telemetry, we can now measure the real distribution instead of false-alarming.
  useEffect(() => {
    if (!workspaceId) return
    const wsId = workspaceId
    const capturedSource = workspaceSourceRef.current
    const capturedWsCount = workspacesRef.current.length

    const timer = setTimeout(() => {
      // Analytics: fire timeout event if issues haven't rendered yet.
      // Gated by issuesEventFiredRef to prevent duplicate events.
      if (issuesEventFiredRef.current !== wsId && timeoutFiredRef.current !== wsId) {
        timeoutFiredRef.current = wsId
        if (getAnalyticsEnabled()) {
          const origin = loadStartTimeRef.current
          const switchOrigin = switchStartTimeRef.current
          safeCapture("app_workspace_load_timeout", {
            workspace_count: capturedWsCount,
            source: capturedSource,
            elapsed_ms: origin > 0 ? Date.now() - origin : WORKSPACE_LOAD_TIMEOUT_MS,
            // bb-kr64: per-switch timer survives auto-retries; null if the
            // timeout fires before app_workspace_opened anchored it.
            initial_switch_ms: switchOrigin > 0 ? Date.now() - switchOrigin : null,
          })
        }
      }

      // Silent failure detection (independent of analytics guard):
      // If threshold passed with no data and no error, show error state
      // with retry instead of empty state. Skip if a load is actively
      // in-flight (the server action will resolve with data or error on
      // its own; firing here causes a false "did not respond" on slow
      // first connections, e.g. server workspaces with setup overhead).
      if (
        !hasExistingDataRef.current &&
        isHealthReady(appHealthRef) &&
        !loadInProgressRef.current
      ) {
        setIsLoading(false)
        loadInProgressRef.current = false
        setHealthError(
          "Workspace did not respond within 15 seconds. The Dolt server may not be running.",
          {
            category: "server-unreachable",
            severity: "recoverable",
            message:
              "Workspace did not respond within 15 seconds. The Dolt server may not be running.",
            stderr: null,
            fixCommand: "bd doctor",
            fixDescription: "Run bd doctor to diagnose and restart the Dolt server",
          },
        )
      }
    }, WORKSPACE_LOAD_TIMEOUT_MS)

    return () => clearTimeout(timer)
  }, [workspaceId, appHealthRef, setHealthError])

  // Refresh workspace list on workspace change (picks up newly added workspaces)
  useEffect(() => {
    const selected = currentWorkspaceRef.current
    if (!selected || !workspaceId) return
    const selectedWorkspace = selected
    let active = true
    async function refreshWorkspaces() {
      const ws = await rpc.workspaces.getWorkspaces(workspaceDbPath)
      if (!active) return
      // Preserve the current workspace if it was resolved via cookie fallback
      // but isn't in the registry (unregistered workspace loaded via direct link).
      if (!ws.some((w) => w.id === selectedWorkspace.id)) {
        ws.push(selectedWorkspace)
      }
      setWorkspaces(ws)
    }
    void refreshWorkspaces()
    return () => {
      active = false
    }
  }, [workspaceId, workspaceDbPath])

  // Handle workspace removal (unregister from registry, not delete data)
  const doRemoveWorkspace = useCallback(
    async (workspace: Workspace) => {
      if (!workspace.databasePath || removingWorkspaceId) return
      setRemovingWorkspaceId(workspace.id)
      try {
        const result = await unregisterWorkspace(workspace, "ui")
        if (!result.ok) {
          toastError("Failed to remove workspace", { description: result.error })
          return
        }
        // Compute the survivors first: setWorkspaceCookie publishes
        // synchronously, and doing that inside a setState updater would
        // re-enter every cookie subscriber during the render phase.
        const remaining = workspacesRef.current.filter((w) => w.id !== workspace.id)
        setWorkspaces(remaining)
        toast.success(`Removed "${workspace.name}" from workspace list`)
        if (!currentWorkspace || workspace.id !== currentWorkspace.id) return
        const next = remaining[0]
        if (!next) {
          navigate({ to: "/workspaces" })
          return
        }
        setCurrentWorkspace(next)
        setWorkspaceCookie(next.id)
      } finally {
        setRemovingWorkspaceId(null)
        setRemoveConfirm(null)
      }
    },
    [currentWorkspace, navigate, removingWorkspaceId],
  )

  // If removing the active workspace, show confirmation first.
  const handleRemoveWorkspace = useCallback(
    (workspace: Workspace) => {
      if (!workspace.databasePath || removingWorkspaceId) return
      if (currentWorkspace && workspace.id === currentWorkspace.id) {
        setRemoveConfirm(workspace)
        return
      }
      void doRemoveWorkspace(workspace)
    },
    [currentWorkspace, removingWorkspaceId, doRemoveWorkspace],
  )

  // bb-fe03.7: loadEpics was a 109-NLOC anonymous useCallback at CCN 27 —
  // success/error/catch branches plus 3 stale-gen checks plus a flock-clear
  // sub-branch and a bd-CLI-disappear sub-branch. Extracted into three
  // helpers below; loadEpics is now a thin orchestrator (CCN ~7). Each
  // helper closes over the hook's state via useCallback.

  // Success branch: persist epics, clear flock contention, hydrate read state.
  const handleEpicsSuccess = useCallback(
    (result: { epics: Epic[]; workspaceId?: string; includeSystem: boolean }) => {
      setEpics(result.epics)
      epicsWorkspaceIdRef.current = treeCacheKey(result.workspaceId, result.includeSystem) ?? null
      hasExistingDataRef.current = true
      setHealthy()
      // Clear flock contention state on success
      if (flockContention) {
        setFlockContention(false)
        setFlockBanner(false)
        flockStartRef.current = null
        if (flockBannerTimerRef.current) {
          clearTimeout(flockBannerTimerRef.current)
          flockBannerTimerRef.current = null
        }
      }
      // Initialize or refresh read state
      const existingReadState = getReadState()
      if (Object.keys(existingReadState).length === 0) {
        const allBeads = collectAllBeadsFromEpics(result.epics)
        setReadStateLocal(initializeReadState(allBeads))
      } else {
        setReadStateLocal(existingReadState)
      }
    },
    [flockContention, setHealthy],
  )

  // bb-93xp: bb-CLI-disappearance heuristic kept for future error
  // routing, but no longer triggers the (removed) yellow banner. The
  // setHealthError / setFatal calls below handle the actual user-facing
  // surface via the AppHealth toast/badge channel.
  const _isBdMissing = (cat: string | undefined, msg: string): boolean =>
    cat === "permission-denied" ||
    msg.includes("ENOENT") ||
    msg.includes("EACCES") ||
    msg.includes("BD_NOT_FOUND")
  void _isBdMissing

  // Error branch: classify by category + severity, dispatch to health
  // state machine, fire telemetry for manual-switch failures.
  const handleEpicsError = useCallback(
    (bdLoadError: BdLoadError, source: "auto" | "manual", getEpicsStart: number) => {
      captureServerActionFailed("getEpics", bdLoadError.message, Date.now() - getEpicsStart)
      console.error("Failed to load epics:", bdLoadError.message)

      // Flock contention: keep stale data visible; let auto-retry recover.
      if (bdLoadError.category === "flock-contention") {
        const sanitized: BdLoadError = {
          ...bdLoadError,
          message: "Workspace busy, retrying...",
          stderr: null,
        }
        setHealthError(sanitized.message, sanitized, true)
        setFlockContention(true)
        if (!flockStartRef.current) {
          flockStartRef.current = Date.now()
          flockBannerTimerRef.current = setTimeout(() => setFlockBanner(true), 30_000)
        }
      } else if (bdLoadError.severity === "fatal") {
        setFatal(bdLoadError.message, bdLoadError)
      } else {
        setHealthError(bdLoadError.message, bdLoadError, true)
      }

      if (!hasExistingDataRef.current) setEpics([])

      if (source === "manual" && getAnalyticsEnabled()) {
        safeCapture("app_workspace_switch_failed", {
          error_category: bdLoadError.category,
          elapsed_ms: Date.now() - (loadStartTimeRef.current ?? Date.now()),
          workspace_count: workspaces.length,
        })
      }
    },
    [setFatal, setHealthError, workspaces.length],
  )

  // Catch branch: unknown thrown error (network failure, kkrpc disconnect,
  // etc.) — bd's category-rich error wasn't surfaced; treat as transient.
  const handleEpicsCatch = useCallback(
    (error: unknown, source: "auto" | "manual") => {
      console.error("Failed to load epics:", error)
      const msg = error instanceof Error ? error.message : String(error)
      const unknownError: BdLoadError = {
        category: "unknown",
        severity: "transient",
        message: msg,
        stderr: null,
        fixCommand: null,
        fixDescription: null,
      }
      setHealthError(msg, unknownError, true)
      if (!hasExistingDataRef.current) setEpics([])

      if (source === "manual" && getAnalyticsEnabled()) {
        safeCapture("app_workspace_switch_failed", {
          error_category: "unknown",
          elapsed_ms: Date.now() - (loadStartTimeRef.current ?? Date.now()),
          workspace_count: workspaces.length,
        })
      }
    },
    [setHealthError, workspaces.length],
  )

  // Fetch epics when workspace changes.
  const loadEpics = useCallback(async () => {
    // Increment generation counter. Any in-flight load from a prior call
    // sees a stale gen and discards its results in the finally block.
    const gen = ++loadGenRef.current
    const source = workspaceSourceRef.current
    // Reset to "auto" after capturing so auto-retries don't fire
    // switch_failed events.
    workspaceSourceRef.current = "auto"
    loadInProgressRef.current = true
    loadStartTimeRef.current = Date.now()
    setIsLoading(true)
    // Clear health on load start so auto-retry resets.
    setHealthy()
    const dbPathForStamp = currentWorkspace?.databasePath ?? null
    recordLoadEpicsPhase("start", gen, dbPathForStamp)
    const workspaceId = currentWorkspace?.id
    try {
      const getEpicsStart = Date.now()
      const result = await rpc.epics.getEpics(workspaceId, includeSystem)
      if (gen !== loadGenRef.current) {
        recordLoadEpicsPhase("stale", gen, dbPathForStamp, {
          epicsLength: result.success ? result.epics.length : undefined,
        })
        return
      }
      if (result.success) {
        recordLoadEpicsPhase("resolved", gen, dbPathForStamp, {
          epicsLength: result.epics.length,
        })
        // Remember the tree so a switch back to this workspace paints
        // instantly instead of flashing the skeleton.
        sessionEpics.set(treeCacheKey(workspaceId, includeSystem), result.epics)
        handleEpicsSuccess({ epics: result.epics, workspaceId, includeSystem })
      } else {
        recordLoadEpicsPhase("error", gen, dbPathForStamp, {
          errorMessage: result.bdLoadError.message,
        })
        handleEpicsError(result.bdLoadError, source, getEpicsStart)
      }
    } catch (error: unknown) {
      if (gen !== loadGenRef.current) {
        recordLoadEpicsPhase("stale", gen, dbPathForStamp, {
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        return
      }
      recordLoadEpicsPhase("error", gen, dbPathForStamp, {
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      handleEpicsCatch(error, source)
    } finally {
      // Only the latest generation owns shared state.
      if (gen === loadGenRef.current) {
        setIsLoading(false)
        setIsSlowLoad(false)
        setLoadingWorkspaceId(null)
        loadInProgressRef.current = false
        lastLoadCompletedRef.current = Date.now()
      }
    }
  }, [
    currentWorkspace?.databasePath,
    currentWorkspace?.id,
    includeSystem,
    handleEpicsSuccess,
    handleEpicsError,
    handleEpicsCatch,
    setHealthy,
  ])

  // Clear all auto-retry timers
  const clearAutoRetry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
    setAutoRetryCountdown(null)
  }, [])

  // Auto-retry transient errors with exponential backoff: 2s, 4s, 8s (max 3 attempts)
  useEffect(() => {
    if (!loadError || loadError.severity !== "transient") {
      clearAutoRetry()
      return
    }

    const delays = [2, 4, 8]
    // Stop auto-retrying after max attempts; user must click manual Retry
    if (retryCountRef.current >= delays.length) {
      clearAutoRetry()
      return
    }

    const delay = delays[retryCountRef.current]
    retryCountRef.current++

    // Start countdown display
    setAutoRetryCountdown(delay)
    countdownTimerRef.current = setInterval(() => {
      setAutoRetryCountdown((prev) => {
        if (prev == null || prev <= 1) return null
        return prev - 1
      })
    }, 1000)

    // Schedule the actual retry. bb-pgb0.1: the post-retry "WS still
    // disconnected → re-apply WS error" branch was deleted with
    // wsConnectedRef. Per pm/systemdesign.md §3.3, the disconnect-banner
    // + health-state transition is now driven by subscription
    // polling_error events handled in lib/subscribe.ts; this hook's
    // duplicate gate was dead.
    retryTimerRef.current = setTimeout(async () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current)
        countdownTimerRef.current = null
      }
      setAutoRetryCountdown(null)
      await loadEpics()
    }, delay * 1000)

    return () => {
      clearAutoRetry()
    }
  }, [loadError, loadEpics, clearAutoRetry])

  // Manual retry handler: resets backoff and retries immediately
  const handleManualRetry = useCallback(() => {
    clearAutoRetry()
    retryCountRef.current = 0
    loadEpics()
  }, [clearAutoRetry, loadEpics])

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      clearAutoRetry()
      retryCountRef.current = 0
      await loadEpics()
    } finally {
      setIsRefreshing(false)
    }
  }, [loadEpics, isRefreshing, clearAutoRetry])

  const fetchAvailableTypes = useCallback(async (requestedWorkspaceId: string, retry = false) => {
    const request = ++typeCatalogRequestRef.current
    setTypeCatalog((previous) => ({
      workspaceId: requestedWorkspaceId,
      status: retry ? "retrying" : "loading",
      message:
        retry && previous?.workspaceId === requestedWorkspaceId ? previous.message : undefined,
    }))
    if (!retry) setAvailableTypes([])
    try {
      const types = await rpc.beads.getAvailableTypes(requestedWorkspaceId)
      if (typeCatalogRequestRef.current !== request) return
      setAvailableTypes(types)
      setTypeCatalog({ workspaceId: requestedWorkspaceId, status: "ready" })
    } catch (error) {
      if (typeCatalogRequestRef.current !== request) return
      setAvailableTypes([])
      setTypeCatalog({
        workspaceId: requestedWorkspaceId,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  const retryAvailableTypes = useCallback(() => {
    if (!workspaceId || typeCatalogRetrying) return
    void fetchAvailableTypes(workspaceId, true)
  }, [workspaceId, typeCatalogRetrying, fetchAvailableTypes])

  // A load callback can change when health or contention state changes. Keep
  // the latest callback without turning those changes into duplicate loads.
  const loadEpicsRef = useRef(loadEpics)
  useEffect(() => {
    loadEpicsRef.current = loadEpics
  }, [loadEpics])

  const treeLoadKey = workspaceId
    ? JSON.stringify([workspaceId, workspaceDbPath, includeSystem])
    : null
  useEffect(() => {
    if (treeLoadKey) void loadEpicsRef.current()
  }, [treeLoadKey])

  useEffect(() => {
    if (workspaceId) {
      let active = true
      // Fetch available statuses for this workspace
      rpc.beads
        .getAvailableStatuses(workspaceId)
        .then((statuses) => {
          if (active) setAvailableStatuses(statuses)
        })
        .catch(() => {
          if (active)
            toast.error("Could not load workspace statuses", { id: "workspace-status-error" })
        })
      // beadbox-3qo: also fetch the ordered status.custom chain for the
      // workflow advancement button (pm/spec §4.3). Empty array = button hidden.
      rpc.beads
        .getCustomStatusList(workspaceId)
        .then((chain) => {
          if (active) setCustomStatusChain(chain)
        })
        .catch(() => {
          if (active)
            toast.error("Could not load workspace statuses", { id: "workspace-status-error" })
        })
      void fetchAvailableTypes(workspaceId)
      // Expose db path for console commands
      const beadbox = ensureBeadboxStamp()
      if (beadbox) beadbox.db = workspaceDbPath
      return () => {
        active = false
        typeCatalogRequestRef.current++
      }
    }
  }, [workspaceId, workspaceDbPath, fetchAvailableTypes])

  // Refetch available statuses (e.g. after user edits custom statuses in the
  // Settings → Workflow tab). Ported from v0.24 hooks/use-workspace-lifecycle
  // (commit 1386b41 / bb-oqux) for bb-wxuw.
  const refreshAvailableStatuses = useCallback(async () => {
    if (!currentWorkspace) return
    const [next, chain] = await Promise.all([
      rpc.beads.getAvailableStatuses(currentWorkspace.id),
      rpc.beads.getCustomStatusList(currentWorkspace.id),
    ])
    setAvailableStatuses(next)
    setCustomStatusChain(chain)
  }, [currentWorkspace])

  // Slow-load detection: show "taking longer than expected" after 10s
  useEffect(() => {
    if (!isLoading) {
      setIsSlowLoad(false)
      return
    }
    const timer = setTimeout(() => {
      if (isLoading) setIsSlowLoad(true)
    }, 10_000)
    return () => clearTimeout(timer)
  }, [isLoading])

  return {
    workspaces,
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
    // beadbox-3qo + beadbox-8k3: the ordered status.custom chain. Eng1
    // loads it via `rpc.beads.getCustomStatusList` for the §4.3 workflow
    // advancement button; the §4.9 activity pipeline card consumes the
    // same field from this hook when its route mounts under the same
    // lifecycle.
    customStatusChain,
    refreshAvailableStatuses,
    loadInProgressRef,
    lastLoadCompletedRef,
    pendingRefreshRef,
    hasExistingDataRef,
    workspaceSourceRef,
    loadEpics,
    handleManualRetry,
    handleRefresh,
    handleRemoveWorkspace,
    doRemoveWorkspace,
  }
}
