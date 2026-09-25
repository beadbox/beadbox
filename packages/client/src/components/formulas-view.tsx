// P3.4 port of components/formulas-view.tsx.
// Source-divergence:
//   - next/navigation useRouter → @tanstack/react-router useRouter;
//     router.push(p) → router.navigate({ to: p as never })
//   - hooks/the legacy ws hook → no direct subscription. Per arch §5 the
//     central useChangeSubscription in __root.tsx fans invalidations.
//     Replaced the WS handler here with a manual refetch effect that
//     reruns when the centrally-bumped TanStack Query 'subscribe' cache
//     key changes. Same parity contract: bead mutations refetch the
//     formula's molecule progress + active overlay within 2s.
//   - actions/formulas.{loadFormulas,loadFormulaDetail,loadFormulaMolecules,
//     loadMoleculeOverlay} → rpc.formulas.*

import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import {
  Activity,
  AlertTriangle,
  Beaker,
  ChevronRight,
  Eye,
  FlaskConical,
  List,
  Loader2,
  Network,
  RefreshCw,
} from "lucide-react"
import posthog from "posthog-js"
import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { useHasTrains } from "@/hooks/use-has-trains"
import { useActiveWorkspace } from "../hooks/use-active-workspace"
import { useAppHealth } from "../hooks/use-app-health"
import { useUpdateChecker } from "../hooks/use-update-checker"
import {
  getAnalyticsEnabled,
  getFormulaViewMode,
  getSelectedFormula,
  getThemePreference,
  getUpdateCheckEnabled,
  getUpdateCheckFrequency,
  getVimNavigationEnabled,
  getZoomLevel,
  setZoomLevel as persistZoomLevel,
  setFormulaViewMode,
  setSelectedFormula,
  setThemePreference,
  setUpdateCheckEnabled,
  setUpdateCheckFrequency,
  setVimNavigationEnabled,
  type ThemeVariant,
  type UpdateCheckFrequency,
} from "../lib/local-storage"
import { safeCapture } from "../lib/posthog-safe"
import { rpc } from "../lib/rpc"
import type {
  FormulaDetail,
  FormulaSummary,
  MoleculeCard,
  MolProgress,
  StepOverlay,
  Workspace,
} from "../lib/types"
import { cn } from "../lib/utils"
import { setWorkspaceCookie } from "../lib/workspace-cookie"
import { FormulaDag } from "./formula-dag"
import { FormulaPourModal } from "./formula-pour-modal"
import { FormulaPreviewModal } from "./formula-preview-modal"
import { FormulaStepDetail } from "./formula-step-detail"
import { FormulaTree } from "./formula-tree"
import { Header } from "./header"
import { SettingsDialog } from "./settings-dialog"
import { useWorkspaceGate } from "./startup-gate"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"
import { UpdateDialog } from "./update-dialog"

// Format {{variables}} in formula names
function formatVars(text: string): React.ReactNode[] {
  return text.split(/(\{\{[^}]+\}\})/).map((part, i) =>
    part.startsWith("{{") ? (
      <span
        key={i}
        className="text-[11px] font-mono px-1 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-500/25 mx-0.5"
      >
        {part.slice(2, -2)}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  )
}

// bb-aurr: Vite doesn't inline non-VITE_-prefixed env vars; in the browser
// bundle `process` itself is undefined, so a bare `process.env.HOME ??`
// throws ReferenceError before the `??` can save it. Guard via typeof.
function getHomePath(): string {
  if (typeof process !== "undefined" && process.env?.HOME) return process.env.HOME
  return "~"
}

// Group formulas by source path origin (project vs user vs orchestrator)
function groupBySource(formulas: FormulaSummary[]): Map<string, FormulaSummary[]> {
  const groups = new Map<string, FormulaSummary[]>()
  const homePath = getHomePath()
  for (const f of formulas) {
    // Derive a friendly group label from the source path
    let label = "Project"
    if (f.source.includes("/.beads/formulas/")) {
      label = "Project"
    } else if (f.source.includes(homePath)) {
      // User-level formulas live under ~/.beads/formulas/
      if (f.source.startsWith(homePath) && !f.source.includes("/Desktop/Projects/")) {
        label = "User"
      }
    }
    const group = groups.get(label) ?? []
    group.push(f)
    groups.set(label, group)
  }
  return groups
}

// Molecule card for the Active Molecules section
function MoleculeCardItem({
  mol,
  active,
  onClick,
  muted,
}: {
  mol: MoleculeCard & { progress: MolProgress }
  active: boolean
  onClick: () => void
  muted?: boolean
}) {
  const pct =
    mol.progress.total > 0 ? Math.round((mol.progress.completed / mol.progress.total) * 100) : 0

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            "w-full text-left px-3 py-2 rounded-md border transition-colors",
            active
              ? "border-primary/50 bg-accent ring-1 ring-primary/30"
              : "border-border/30 hover:border-border hover:bg-accent/30",
            muted && "opacity-50",
          )}
        >
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-sm font-medium text-foreground truncate">{mol.title}</span>
            {mol.assignee && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                @{mol.assignee}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  pct === 100 ? "bg-green-500" : pct > 0 ? "bg-blue-500" : "bg-muted-foreground/30",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0">
              {mol.progress.completed}/{mol.progress.total}
            </span>
          </div>
          {mol.progress.inProgress > 0 && (
            <div className="flex items-center gap-1 mt-1">
              <Activity className="h-3 w-3 text-blue-400" />
              <span className="text-[10px] text-blue-400">
                {mol.progress.inProgress} in progress
              </span>
            </div>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">{mol.title}</p>
        <p className="text-xs text-muted-foreground">
          {mol.progress.completed}/{mol.progress.total} steps complete ({pct}%)
          {mol.progress.inProgress > 0 && `, ${mol.progress.inProgress} in progress`}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Click to {active ? "hide" : "show"} progress on the step diagram
        </p>
      </TooltipContent>
    </Tooltip>
  )
}

export function FormulasView() {
  const { workspaces: initialWorkspaces } = useWorkspaceGate()
  const router = useRouter()
  const [workspaces] = useState<Workspace[]>(initialWorkspaces)
  // Cookie-resolved active workspace (subscribed — see use-active-workspace).
  const [currentWorkspace, setCurrentWorkspace] = useActiveWorkspace(workspaces)
  const hasTrains = useHasTrains(currentWorkspace?.id)
  const [loadingWorkspaceId, setLoadingWorkspaceId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // Settings
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeVariant>("gray")
  const [zoomLevel, setZoomLevelState] = useState(100)
  const isTauriRef = useRef(false)
  const [vimEnabled, setVimEnabledState] = useState(true)
  const [updateCheckEnabled, setUpdateCheckEnabledState] = useState(true)
  const [updateCheckFrequency, setUpdateCheckFrequencyState] =
    useState<UpdateCheckFrequency>(3600000)
  const { health: appHealth, setHealthy } = useAppHealth()
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

  // Formulas state
  const [formulas, setFormulas] = useState<FormulaSummary[]>([])
  const [formulasLoading, setFormulasLoading] = useState(true)
  const [formulasError, setFormulasError] = useState<string | null>(null)
  const [selectedName, setSelectedNameRaw] = useState<string | null>(null)
  const setSelectedName = useCallback((name: string | null) => {
    setSelectedNameRaw(name)
    setSelectedFormula(name)
  }, [])
  const [detail, setDetail] = useState<FormulaDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [viewMode, setViewModeState] = useState<"dag" | "tree">(() => getFormulaViewMode())
  const setViewMode = useCallback((mode: "dag" | "tree") => {
    setViewModeState(mode)
    setFormulaViewMode(mode)
  }, [])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [pourOpen, setPourOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const sidebarDragging = useRef(false)
  const sidebarStartX = useRef(0)
  const sidebarStartW = useRef(300)

  const onSidebarPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      sidebarDragging.current = true
      sidebarStartX.current = e.clientX
      sidebarStartW.current = sidebarWidth
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"

      const onMove = (ev: PointerEvent) => {
        if (!sidebarDragging.current) return
        const delta = ev.clientX - sidebarStartX.current
        setSidebarWidth(Math.max(200, Math.min(600, sidebarStartW.current + delta)))
      }
      const onUp = () => {
        sidebarDragging.current = false
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [sidebarWidth],
  )

  // Active molecules state
  const [molecules, setMolecules] = useState<Array<MoleculeCard & { progress: MolProgress }>>([])
  const [moleculesLoading, setMoleculesLoading] = useState(false)
  const [activeMolId, setActiveMolId] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<Record<string, StepOverlay> | null>(null)
  const [overlayLoading, setOverlayLoading] = useState(false)
  const [showCompletedMols, setShowCompletedMols] = useState(false)

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

  // Apply theme
  useEffect(() => {
    const el = document.documentElement
    el.classList.add("dark")
    el.classList.remove("theme-gray", "theme-green")
    if (theme === "gray") el.classList.add("theme-gray")
    if (theme === "green") el.classList.add("theme-green")
  }, [theme])

  // Apply zoom (Tauri only)
  useEffect(() => {
    if (!isTauriRef.current) return
    document.documentElement.style.zoom = `${zoomLevel}%`
  }, [zoomLevel])

  const databasePath = currentWorkspace?.databasePath

  // Source-parity helper preserved for future use; not yet wired to a
  // workspace-switcher prop. Future P3 chrome bead may surface it.
  const _handleWorkspaceChange = useCallback(
    (workspace: Workspace) => {
      if (workspace.id === currentWorkspace?.id) return
      setLoadingWorkspaceId(workspace.id)
      setWorkspaceCookie(workspace.id)
      setHealthy()
      startTransition(() => {
        setCurrentWorkspace(workspace)
        setLoadingWorkspaceId(null)
      })
    },
    [currentWorkspace?.id, setHealthy, setCurrentWorkspace],
  )

  // Fetch formulas when workspace changes
  const fetchFormulas = useCallback(async () => {
    if (!databasePath) return
    setFormulasLoading(true)
    setFormulasError(null)
    const result = await rpc.formulas.loadFormulas(currentWorkspace?.id)
    if (result.success) {
      setFormulas(result.data)
    } else {
      setFormulasError(result.error)
      setFormulas([])
    }
    setFormulasLoading(false)
  }, [databasePath, currentWorkspace?.id])

  useEffect(() => {
    fetchFormulas()
  }, [fetchFormulas])

  // Restore saved formula selection after formulas load
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current || formulas.length === 0) return
    const saved = getSelectedFormula()
    if (saved && formulas.some((f) => f.name === saved)) {
      setSelectedNameRaw(saved)
    } else {
      // First visit or saved formula no longer exists: select the first one
      setSelectedName(formulas[0].name)
    }
    restoredRef.current = true
  }, [formulas, setSelectedName])

  // Clear step selection when formula changes
  useEffect(() => {
    void selectedName
    setSelectedStepId(null)
  }, [selectedName])

  // Fetch detail when selection changes
  useEffect(() => {
    if (!selectedName || !databasePath) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    rpc.formulas.loadFormulaDetail(selectedName, currentWorkspace?.id).then((result) => {
      if (cancelled) return
      if (result.success) {
        setDetail(result.data)
      } else {
        setDetail(null)
      }
      setDetailLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [selectedName, databasePath, currentWorkspace?.id])

  // Fetch active molecules for the selected formula
  const fetchMolecules = useCallback(async () => {
    if (!selectedName || !databasePath) {
      setMolecules([])
      return
    }
    setMoleculesLoading(true)
    const result = await rpc.formulas.loadFormulaMolecules(selectedName, currentWorkspace?.id)
    if (result.success) {
      setMolecules(result.data)
    } else {
      setMolecules([])
    }
    setMoleculesLoading(false)
  }, [selectedName, databasePath, currentWorkspace?.id])

  useEffect(() => {
    fetchMolecules()
    setActiveMolId(null)
    setOverlay(null)
  }, [fetchMolecules])

  // Fetch overlay when a molecule card is clicked
  const fetchOverlay = useCallback(
    async (molId: string) => {
      if (!detail || !databasePath) return
      setOverlayLoading(true)
      const result = await rpc.formulas.loadMoleculeOverlay(
        molId,
        detail.steps,
        currentWorkspace?.id,
      )
      if (result.success) {
        setOverlay(result.data)
      } else {
        setOverlay(null)
      }
      setOverlayLoading(false)
    },
    [detail, databasePath, currentWorkspace?.id],
  )

  const handleMoleculeClick = useCallback(
    (molId: string) => {
      if (activeMolId === molId) {
        setActiveMolId(null)
        setOverlay(null)
      } else {
        setActiveMolId(molId)
        fetchOverlay(molId)
      }
    },
    [activeMolId, fetchOverlay],
  )

  // Live updates: piggyback on the central change subscription mounted in
  // __root.tsx (P3.1 / arch §5). The 'subscribe' query key is bumped by
  // useChangeSubscription whenever bd emits a bead-mutation event; reading
  // its data here causes this component to re-render and refetch downstream
  // formula state. No second subscription, no duplicate stderr listeners.
  const subscribeTick = useQuery({
    queryKey: ["subscribe", databasePath ?? ""],
    queryFn: () => Promise.resolve(0),
    enabled: !!databasePath,
    staleTime: Infinity,
  }).dataUpdatedAt

  const liveRefreshRef = useRef({
    databasePath,
    selectedName,
    activeMolId,
    fetchMolecules,
    fetchOverlay,
  })
  useEffect(() => {
    liveRefreshRef.current = {
      databasePath,
      selectedName,
      activeMolId,
      fetchMolecules,
      fetchOverlay,
    }
  }, [databasePath, selectedName, activeMolId, fetchMolecules, fetchOverlay])
  useEffect(() => {
    void subscribeTick
    const current = liveRefreshRef.current
    if (!current.databasePath) return
    if (current.selectedName) current.fetchMolecules()
    if (current.activeMolId) current.fetchOverlay(current.activeMolId)
  }, [subscribeTick])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSettingsOpen(true)
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "1" || e.key === "2" || e.key === "4")) {
        e.preventDefault()
        if (e.key === "1") router.navigate({ to: "/" as never })
        if (e.key === "2") router.navigate({ to: "/activity" as never })
        if (e.key === "4" && hasTrains) router.navigate({ to: "/trains" as never })
        return
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [router, hasTrains])

  // Track the workspace mode present when this page mounts.
  const initialWorkspaceModeRef = useRef(currentWorkspace?.mode || "unknown")
  useEffect(() => {
    if (getAnalyticsEnabled()) {
      safeCapture("app_formulas_viewed", {
        workspace_mode: initialWorkspaceModeRef.current,
      })
    }
  }, [])

  const handleThemeChange = (next: ThemeVariant) => {
    setTheme(next)
    setThemePreference(next)
  }
  const handleZoomChange = useCallback((level: number) => {
    const c = Math.max(50, Math.min(200, level))
    setZoomLevelState(c)
    persistZoomLevel(c)
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

  const grouped = groupBySource(formulas)

  return (
    <div className="h-full flex flex-col bg-background safe-area-inset">
      <Header
        currentWorkspace={
          currentWorkspace || { id: "", name: "Loading...", mode: "embedded" as const }
        }
        loadingWorkspaceId={loadingWorkspaceId}
        isPending={isPending}
        appHealth={appHealth}
        versionLabel={
          showRcVersion
            ? `v${import.meta.env.VITE_BUILD_TAG || import.meta.env.VITE_APP_VERSION || "0.0.0"}`
            : undefined
        }
        onSettingsOpen={() => setSettingsOpen(true)}
      />

      <div className="flex-1 flex min-h-0">
        {/* Left sidebar */}
        <div
          className="relative border-r border-border/50 flex flex-col min-h-0"
          style={{ width: sidebarWidth }}
        >
          {/* Resize handle */}
          <div
            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors z-10"
            onPointerDown={onSidebarPointerDown}
          />
          {/* Formula list */}
          <div className="flex-1 overflow-y-auto p-3">
            {formulasLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : formulasError ? (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <AlertTriangle className="h-5 w-5 text-amber-400" />
                <p className="text-sm text-center px-4">{formulasError}</p>
                <button
                  onClick={fetchFormulas}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent hover:bg-accent/80 transition-colors"
                >
                  <RefreshCw className="h-3 w-3" />
                  Retry
                </button>
              </div>
            ) : formulas.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
                <FlaskConical className="h-8 w-8 opacity-50" />
                <p className="text-sm text-center px-4">No formulas in this workspace</p>
                <p className="text-xs text-center px-4 opacity-70">
                  Add .formula.toml files to .beads/formulas/ or ~/.beads/formulas/
                </p>
              </div>
            ) : (
              Array.from(grouped.entries()).map(([groupLabel, items]) => (
                <div key={groupLabel} className="mb-4">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-2 mb-1.5">
                    {groupLabel}
                  </div>
                  {items.map((f) => (
                    <button
                      key={f.name}
                      onClick={() => setSelectedName(selectedName === f.name ? null : f.name)}
                      className={cn(
                        "w-full text-left px-2 py-2 rounded-md text-sm transition-colors flex items-center justify-between gap-2",
                        selectedName === f.name
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                      )}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <FlaskConical className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{formatVars(f.name)}</span>
                      </span>
                      <span className="text-xs text-muted-foreground/60 shrink-0">
                        {f.steps} steps
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* Detail subpanel */}
          {selectedName && (
            <div className="border-t border-border/50 p-3 pb-6 max-h-[280px] overflow-y-auto">
              {detailLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : detail ? (
                <div className="space-y-3">
                  <div>
                    <h3 className="text-base font-semibold text-foreground">
                      {formatVars(detail.formula)}
                    </h3>
                    {detail.description && (
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-3">
                        {detail.description.split("\n")[0]}
                      </p>
                    )}
                  </div>
                  {Object.keys(detail.vars).length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">
                        Variables
                      </div>
                      <div className="space-y-1.5">
                        {Object.entries(detail.vars).map(([name, v]) => (
                          <div key={name} className="flex items-center gap-2 text-sm">
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                            <span className="font-mono text-foreground">{name}</span>
                            {v.required && (
                              <span className="text-[10px] text-amber-400/80">required</span>
                            )}
                            {v.default && (
                              <span className="text-muted-foreground/60">= {v.default}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Could not load formula details</p>
              )}
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className="flex-1 flex flex-col min-h-0">
          {detail ? (
            <>
              <div className="px-4 py-2.5 border-b border-border/50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Step Graph
                  </span>
                  <div className="flex items-center bg-zinc-800/50 rounded-md p-0.5">
                    <button
                      onClick={() => setViewMode("tree")}
                      className={cn(
                        "p-1 rounded transition-colors",
                        viewMode === "tree"
                          ? "bg-zinc-700 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      title="Tree view"
                    >
                      <List className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setViewMode("dag")}
                      className={cn(
                        "p-1 rounded transition-colors",
                        viewMode === "dag"
                          ? "bg-zinc-700 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      title="Graph view"
                    >
                      <Network className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setPreviewOpen(true)}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border border-border/60 bg-secondary/50 text-secondary-foreground hover:bg-secondary transition-colors"
                      >
                        <Eye className="h-4 w-4" />
                        Preview
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Preview cooked formula (read-only)</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setPourOpen(true)}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                      >
                        <Beaker className="h-4 w-4" />
                        Pour
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Create a live molecule from this formula</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex-1 flex min-h-0">
                  {viewMode === "dag" ? (
                    <FormulaDag
                      steps={detail.steps}
                      selectedStepId={selectedStepId}
                      onStepClick={setSelectedStepId}
                      overlay={overlay ?? undefined}
                    />
                  ) : (
                    <FormulaTree
                      steps={detail.steps}
                      selectedStepId={selectedStepId}
                      onStepClick={setSelectedStepId}
                      overlay={overlay ?? undefined}
                    />
                  )}
                  {selectedStepId && detail.steps.find((s) => s.id === selectedStepId) && (
                    <FormulaStepDetail
                      step={detail.steps.find((s) => s.id === selectedStepId)!}
                      allSteps={detail.steps}
                      onClose={() => setSelectedStepId(null)}
                      onNavigateToStep={setSelectedStepId}
                    />
                  )}
                </div>

                {/* Active Molecules section */}
                <div className="border-t border-border/50 max-h-[220px] overflow-y-auto">
                  <div className="px-4 py-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Active Molecules ({molecules.filter((m) => m.status !== "closed").length})
                    </span>
                    {overlayLoading && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <div className="px-4 pb-3 space-y-2">
                    {moleculesLoading ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : molecules.filter((m) => m.status !== "closed").length === 0 &&
                      !showCompletedMols ? (
                      <p className="text-xs text-muted-foreground/60 py-2">
                        No active workflows. Click Pour to start one.
                      </p>
                    ) : (
                      <>
                        {molecules
                          .filter((m) => m.status !== "closed")
                          .map((mol) => (
                            <MoleculeCardItem
                              key={mol.id}
                              mol={mol}
                              active={activeMolId === mol.id}
                              onClick={() => handleMoleculeClick(mol.id)}
                            />
                          ))}
                        {molecules.some((m) => m.status === "closed") && (
                          <button
                            onClick={() => setShowCompletedMols(!showCompletedMols)}
                            className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                          >
                            {showCompletedMols ? "Hide" : "Show"} completed (
                            {molecules.filter((m) => m.status === "closed").length})
                          </button>
                        )}
                        {showCompletedMols &&
                          molecules
                            .filter((m) => m.status === "closed")
                            .map((mol) => (
                              <MoleculeCardItem
                                key={mol.id}
                                mol={mol}
                                active={activeMolId === mol.id}
                                onClick={() => handleMoleculeClick(mol.id)}
                                muted
                              />
                            ))}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground/40">
              <div className="text-center">
                <FlaskConical className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">Select a formula to view its step graph</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        theme={theme}
        onThemeChange={handleThemeChange}
        zoomLevel={zoomLevel}
        onZoomChange={handleZoomChange}
        databasePath={databasePath}
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

      {detail && (
        <FormulaPreviewModal
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          formula={detail}
          dbPath={currentWorkspace?.id}
        />
      )}

      {detail && (
        <FormulaPourModal
          open={pourOpen}
          onOpenChange={setPourOpen}
          formula={detail}
          dbPath={currentWorkspace?.id}
        />
      )}

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
    </div>
  )
}
