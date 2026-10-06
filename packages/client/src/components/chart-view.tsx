// Chart view (beadbox-eic): a Gantt per epic. Data comes the way the other
// lightweight pages load it (react-query keyed on the live-update signal);
// filters are the Beads view's own saved state, so a filter set on one view
// applies on the other.

import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ChartGantt } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { FilterBar } from "@/components/filter-bar"
import { GanttChart } from "@/components/gantt-chart"
import { Header } from "@/components/header"
import { SettingsDialog } from "@/components/settings-dialog"
import { useWorkspaceGate } from "@/components/startup-gate"
import { UpdateDialog } from "@/components/update-dialog"
import { useActiveWorkspace } from "@/hooks/use-active-workspace"
import { useAppHealth } from "@/hooks/use-app-health"
import { useHasTrains } from "@/hooks/use-has-trains"
import { usePreferences } from "@/hooks/use-preferences"
import { useUpdateChecker } from "@/hooks/use-update-checker"
import { readSystemIssues, systemIssuesKey } from "@/hooks/use-workspace-lifecycle"
import { extractAssignees, extractRigNames, flattenEpicsToBeads } from "@/lib/epic-tree-utils"
import { buildGanttModel } from "@/lib/gantt-model"
import { setSelectedBead as persistSelectedBead } from "@/lib/local-storage"
import { rpc } from "@/lib/rpc"
import { useSubscriptionChangeSignal } from "@/lib/subscribe"
import { tryViewSwitchShortcut } from "@/lib/view-switch-keys"

const NOW_TICK_MS = 60_000

const typeKey = (workspaceId: string) => `beadbox:issue-type:${workspaceId}`

function readType(workspaceId: string | undefined): string {
  if (!workspaceId) return "all"
  try {
    return localStorage.getItem(typeKey(workspaceId)) || "all"
  } catch {
    return "all"
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable: the choice lasts until reload
  }
}

// Bars of running beads end at "now"; advance it while the view is mounted.
export function useNow(intervalMs = NOW_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function useChartData(dbPath: string | undefined, includeSystem: boolean) {
  const changeSignal = useSubscriptionChangeSignal()
  const epicsQuery = useQuery({
    queryKey: ["chart-epics", dbPath, includeSystem, changeSignal],
    queryFn: async () => {
      const result = await rpc.epics.incrementalRefresh(dbPath, includeSystem)
      if (!result.success) throw new Error(result.bdLoadError.message)
      return result.epics
    },
    enabled: Boolean(dbPath),
    placeholderData: (previous) => previous,
  })
  // A degraded answer is shown as a notice, never read as "no blockers".
  const blocksQuery = useQuery({
    queryKey: ["chart-blocks", dbPath, changeSignal],
    queryFn: () => rpc.epics.getBlocksDependencies(dbPath),
    enabled: Boolean(dbPath),
    placeholderData: (previous) => previous,
  })
  const statusesQuery = useQuery({
    queryKey: ["chart-statuses", dbPath],
    queryFn: () => rpc.beads.getAvailableStatuses(dbPath),
    enabled: Boolean(dbPath),
  })
  const typesQuery = useQuery({
    queryKey: ["chart-types", dbPath],
    queryFn: () => rpc.beads.getAvailableTypes(dbPath),
    enabled: Boolean(dbPath),
  })
  return { epicsQuery, blocksQuery, statusesQuery, typesQuery }
}

export function ChartView() {
  const { workspaces: initialWorkspaces } = useWorkspaceGate()
  const [workspaces] = useState(initialWorkspaces)
  const [currentWorkspace] = useActiveWorkspace(workspaces)
  const navigate = useNavigate()
  const { health: appHealth } = useAppHealth()
  const prefs = usePreferences()
  const hasTrains = useHasTrains(currentWorkspace?.databasePath)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const {
    updateAvailable,
    checking: updateChecking,
    checkNow: checkForUpdates,
    checkError: updateCheckError,
    dismissUpdate,
  } = useUpdateChecker({
    enabled: prefs.updateCheckEnabled,
    frequency: prefs.updateCheckFrequency,
  })

  const workspaceId = currentWorkspace?.id
  const dbPath = currentWorkspace?.databasePath
  const [selectedType, setSelectedType] = useState(() => readType(workspaceId))
  const [includeSystem, setIncludeSystem] = useState(() => readSystemIssues(workspaceId))
  useEffect(() => {
    setSelectedType(readType(workspaceId))
    setIncludeSystem(readSystemIssues(workspaceId))
  }, [workspaceId])

  const { epicsQuery, blocksQuery, statusesQuery, typesQuery } = useChartData(dbPath, includeSystem)
  const epics = epicsQuery.data ?? []
  const now = useNow()

  const assignees = useMemo(() => extractAssignees(epics), [epics])
  const rigNames = useMemo(() => extractRigNames(epics), [epics])
  const typeOptions = useMemo(
    () => [...new Set([...(typesQuery.data ?? []), ...epics.map((e) => e.type), ...flattenEpicsToBeads(epics).map((b) => b.type)])],
    [typesQuery.data, epics],
  )
  const model = useMemo(
    () =>
      buildGanttModel(
        epics,
        blocksQuery.data?.degraded ? null : (blocksQuery.data?.blockedBy ?? {}),
        { ...prefs.filters, type: selectedType, includeSystem },
        now,
        rigNames,
      ),
    [epics, blocksQuery.data, prefs.filters, selectedType, includeSystem, now, rigNames],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      tryViewSwitchShortcut(e, { push: (to) => void navigate({ to: to as never }), hasTrains })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate, hasTrains])

  const openBead = (id: string) => {
    persistSelectedBead(id)
    void navigate({ to: "/" })
  }

  return (
    <div className="h-full flex flex-col bg-background safe-area-inset">
      <Header
        currentWorkspace={currentWorkspace || { id: "", name: "Loading...", mode: "embedded" as const }}
        isRefreshing={epicsQuery.isFetching}
        isPending={epicsQuery.isLoading}
        appHealth={appHealth}
        onRefresh={() => {
          void epicsQuery.refetch()
          void blocksQuery.refetch()
        }}
        updateAvailable={updateAvailable}
        onUpdateClick={() => setUpdateDialogOpen(true)}
        onSettingsOpen={() => setSettingsOpen(true)}
      />

      <main className="flex-1 min-h-0 flex flex-col w-full px-6 py-4 gap-3">
        <div className="flex items-center gap-2">
          <ChartGantt className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Chart</h1>
        </div>
        <FilterBar
          filters={prefs.filters}
          onFiltersChange={prefs.setFilters}
          assignees={assignees}
          rigNames={rigNames}
          availableStatuses={statusesQuery.data}
          availableTypes={typeOptions}
          selectedType={selectedType}
          onTypeChange={(type) => {
            if (!workspaceId) return
            writeStorage(typeKey(workspaceId), type)
            setSelectedType(type)
          }}
          includeSystem={includeSystem}
          onIncludeSystemChange={(enabled) => {
            if (!workspaceId) return
            writeStorage(systemIssuesKey(workspaceId), String(enabled))
            setIncludeSystem(enabled)
          }}
        />
        {blocksQuery.data?.degraded && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-300">
            <span>
              Blocked-by markers are unavailable: {blocksQuery.data.degraded.message}. The chart does not show what is
              blocked.
            </span>
            <button
              type="button"
              onClick={() => void blocksQuery.refetch()}
              className="shrink-0 rounded px-2 py-1 font-medium hover:bg-amber-500/20"
            >
              Retry
            </button>
          </div>
        )}
        {epicsQuery.isError ? (
          <p className="text-sm text-destructive">Could not load beads: {String(epicsQuery.error)}</p>
        ) : epicsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <GanttChart model={model} now={now} onOpenBead={openBead} />
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        theme={prefs.theme}
        onThemeChange={prefs.handleThemeChange}
        zoomLevel={prefs.zoomLevel}
        onZoomChange={prefs.handleZoomChange}
        databasePath={dbPath}
        vimNavigationEnabled={prefs.vimEnabled}
        onVimNavigationChange={prefs.handleVimNavigationChange}
        updateCheckEnabled={prefs.updateCheckEnabled}
        onUpdateCheckEnabledChange={prefs.handleUpdateCheckEnabledChange}
        updateCheckFrequency={prefs.updateCheckFrequency}
        onUpdateCheckFrequencyChange={prefs.handleUpdateCheckFrequencyChange}
        updateAvailable={updateAvailable}
        updateChecking={updateChecking}
        updateCheckError={updateCheckError}
        onCheckForUpdates={checkForUpdates}
        onOpenUpdateDialog={() => setUpdateDialogOpen(true)}
      />

      {updateAvailable ? (
        <UpdateDialog
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          updateInfo={updateAvailable}
          onDismiss={dismissUpdate}
          currentVersion={import.meta.env.VITE_APP_VERSION || "0.0.0"}
        />
      ) : null}
    </div>
  )
}
