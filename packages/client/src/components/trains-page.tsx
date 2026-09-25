import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Loader2, TrainFront } from "lucide-react"
import { useMemo, useState } from "react"
import { useAppHealth } from "../hooks/use-app-health"
import { usePreferences } from "../hooks/use-preferences"
import { useUpdateChecker } from "../hooks/use-update-checker"
import { setSelectedBead as persistSelectedBead } from "../lib/local-storage"
import { rpc } from "../lib/rpc"
import { useSubscriptionChangeSignal } from "../lib/subscribe"
import type { Workspace } from "../lib/types"
import { getWorkspaceCookie } from "../lib/workspace-cookie"
import { Header } from "./header"
import { SettingsDialog } from "./settings-dialog"
import { useWorkspaceGate } from "./startup-gate"
import { UpdateDialog } from "./update-dialog"

function unwrap<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw new Error(result.error)
  return result.data
}

// Payload types are derived from the RPC surface so the server stays the single
// source of truth for the .beadtrain shapes (no client-side copy to drift).
type Ok<T> = T extends { success: true; data: infer D } ? D : never
type Train = Ok<Awaited<ReturnType<typeof rpc.trains.loadTrains>>>[number]
type ReadyRow = Ok<Awaited<ReturnType<typeof rpc.trains.loadReady>>>[number]
type CouplerRow = Ok<Awaited<ReturnType<typeof rpc.trains.loadCouplers>>>[number]

function TrainList({
  trains,
  ready,
  selectedName,
  onSelect,
}: {
  trains: Train[]
  ready: ReadyRow[]
  selectedName: string | null
  onSelect: (name: string) => void
}) {
  return (
    <section className="space-y-2">
      {trains.map((train) => {
        const readyCount = ready.filter((row) => row.train === train.name && row.ready).length
        const active = selectedName === train.name
        return (
          <button
            key={train.name}
            type="button"
            onClick={() => onSelect(train.name)}
            className={`w-full text-left rounded-md border px-3 py-2 ${
              active ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">{train.name}</span>
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {train.status}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {train.cars.length} cars
              {readyCount > 0 ? ` · ${readyCount} ready` : ""}
            </div>
          </button>
        )
      })}
    </section>
  )
}

function CarRow({
  car,
  view,
  onOpenBead,
}: {
  car: Train["cars"][number]
  view: ReadyRow | undefined
  onOpenBead: (bead: string) => void
}) {
  return (
    <li className="rounded-md border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="font-mono text-sm hover:underline"
          onClick={() => onOpenBead(car.bead)}
        >
          {car.id} · {car.bead}
        </button>
        <span className="text-[11px] uppercase">
          {view?.ready ? "ready" : (view?.beadStatus ?? "wait")}
        </span>
      </div>
      <p className="text-sm">{car.title}</p>
      {view ? <p className="text-xs text-muted-foreground">{view.reason}</p> : null}
    </li>
  )
}

function CouplerList({ couplers, trainName }: { couplers: CouplerRow[]; trainName: string }) {
  const rows = couplers.filter((row) => row.fromTrain === trainName || row.toTrain === trainName)
  if (rows.length === 0) return null
  return (
    <div>
      <h3 className="text-sm font-medium mb-2">Couplers</h3>
      <ul className="space-y-1 text-sm font-mono">
        {rows.map((row) => (
          <li key={row.id}>
            {row.fromTrain}/{row.fromCar} -{row.mode}-&gt; {row.toTrain}/{row.toCar}
          </li>
        ))}
      </ul>
    </div>
  )
}

function TrainDetail({
  train,
  readyRows,
  couplers,
  onOpenBead,
}: {
  train: Train
  readyRows: ReadyRow[]
  couplers: CouplerRow[]
  onOpenBead: (bead: string) => void
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{train.title || train.name}</h2>
        {train.oneLiner ? <p className="text-sm text-muted-foreground">{train.oneLiner}</p> : null}
      </div>
      <ul className="space-y-2">
        {train.cars.map((car) => (
          <CarRow
            key={car.id}
            car={car}
            view={readyRows.find((row) => row.carId === car.id)}
            onOpenBead={onOpenBead}
          />
        ))}
      </ul>
      <CouplerList couplers={couplers} trainName={train.name} />
    </section>
  )
}

function TrainsBody({
  isLoading,
  isError,
  error,
  trains,
  ready,
  couplers,
  selected,
  readyForSelected,
  onSelect,
  onOpenBead,
}: {
  isLoading: boolean
  isError: boolean
  error: unknown
  trains: Train[]
  ready: ReadyRow[]
  couplers: CouplerRow[]
  selected: Train | null
  readyForSelected: ReadyRow[]
  onSelect: (name: string) => void
  onOpenBead: (bead: string) => void
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading trains
      </div>
    )
  }
  if (isError) {
    return (
      <p className="text-destructive">
        Could not load train plans: {error instanceof Error ? error.message : "unknown error"}
      </p>
    )
  }
  if (trains.length === 0) {
    return <p className="text-muted-foreground">No .beadtrain files in this workspace .beads folder.</p>
  }
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(16rem,22rem)_1fr]">
      <TrainList trains={trains} ready={ready} selectedName={selected?.name ?? null} onSelect={onSelect} />
      {selected ? (
        <TrainDetail train={selected} readyRows={readyForSelected} couplers={couplers} onOpenBead={onOpenBead} />
      ) : null}
    </div>
  )
}

/** The three train queries + their empty defaults, keyed on the change signal so plan edits refetch. */
function useTrainsData(dbPath: string | undefined) {
  const changeSignal = useSubscriptionChangeSignal()
  const trainsQuery = useQuery({
    queryKey: ["trains", dbPath, changeSignal],
    queryFn: async () => unwrap(await rpc.trains.loadTrains(dbPath)),
    enabled: Boolean(dbPath),
  })
  const readyQuery = useQuery({
    queryKey: ["trains-ready", dbPath, changeSignal],
    queryFn: async () => unwrap(await rpc.trains.loadReady(dbPath)),
    enabled: Boolean(dbPath),
  })
  const couplerQuery = useQuery({
    queryKey: ["trains-couplers", dbPath, changeSignal],
    queryFn: async () => unwrap(await rpc.trains.loadCouplers(dbPath)),
    enabled: Boolean(dbPath),
  })
  return {
    trainsQuery,
    readyQuery,
    couplerQuery,
    trains: trainsQuery.data ?? [],
    ready: readyQuery.data ?? [],
    couplers: couplerQuery.data ?? [],
  }
}

export function TrainsPage() {
  const { workspaces } = useWorkspaceGate()
  const navigate = useNavigate()
  const { health: appHealth } = useAppHealth()
  const prefs = usePreferences()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [selectedName, setSelectedName] = useState<string | null>(null)
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

  const currentWorkspace: Workspace | null = useMemo(() => {
    const cookie = getWorkspaceCookie()
    return workspaces.find((ws) => ws.id === cookie) ?? workspaces[0] ?? null
  }, [workspaces])

  const dbPath = currentWorkspace?.databasePath

  const { trainsQuery, readyQuery, couplerQuery, trains, ready, couplers } = useTrainsData(currentWorkspace?.id)
  const selected = trains.find((train) => train.name === selectedName) ?? trains[0] ?? null
  const readyForSelected = ready.filter((row) => row.train === selected?.name)
  const openBead = (bead: string) => {
    persistSelectedBead(bead)
    void navigate({ to: "/" })
  }

  return (
    <div className="h-full flex flex-col bg-background safe-area-inset">
      <Header
        currentWorkspace={
          currentWorkspace || { id: "", name: "Loading...", mode: "embedded" as const }
        }
        isRefreshing={trainsQuery.isFetching}
        isPending={trainsQuery.isLoading}
        appHealth={appHealth}
        onRefresh={() => {
          void trainsQuery.refetch()
          void readyQuery.refetch()
          void couplerQuery.refetch()
        }}
        updateAvailable={updateAvailable}
        onUpdateClick={() => setUpdateDialogOpen(true)}
        onSettingsOpen={() => setSettingsOpen(true)}
      />

      <main className="flex-1 overflow-y-auto mx-auto w-full max-w-6xl px-6 py-6 space-y-6">
        <div className="flex items-center gap-2">
          <TrainFront className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Trains</h1>
          <span className="text-sm text-muted-foreground">
            .beadtrain plans beside this workspace. Tickets stay in bd.
          </span>
        </div>
        <TrainsBody
          isLoading={trainsQuery.isLoading}
          isError={trainsQuery.isError}
          error={trainsQuery.error}
          trains={trains}
          ready={ready}
          couplers={couplers}
          selected={selected}
          readyForSelected={readyForSelected}
          onSelect={setSelectedName}
          onOpenBead={openBead}
        />
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        theme={prefs.theme}
        onThemeChange={prefs.handleThemeChange}
        zoomLevel={prefs.zoomLevel}
        onZoomChange={prefs.handleZoomChange}
        databasePath={dbPath}
        workspaceId={currentWorkspace?.id}
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
