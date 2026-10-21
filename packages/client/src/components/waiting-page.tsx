import { useNavigate } from "@tanstack/react-router"
import { Hourglass, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useActiveWorkspace } from "../hooks/use-active-workspace"
import { useAppHealth } from "../hooks/use-app-health"
import { useHasTrains } from "../hooks/use-has-trains"
import { usePreferences } from "../hooks/use-preferences"
import { useUpdateChecker } from "../hooks/use-update-checker"
import { useRefreshWaiting, useWaitingGates } from "../hooks/use-waiting-gates"
import { trackedAction } from "../lib/capture-action-failed"
import { setSelectedBead as persistSelectedBead } from "../lib/local-storage"
import { toastError } from "../lib/notifications"
import { rpc } from "../lib/rpc"
import { cn } from "../lib/utils"
import { tryViewSwitchShortcut } from "../lib/view-switch-keys"
import {
  describeAwait,
  describeDeadline,
  gateTypeClass,
  gateTypeLabel,
  waitingSince,
} from "../lib/waiting"
import { Header } from "./header"
import { SettingsDialog } from "./settings-dialog"
import { useWorkspaceGate } from "./startup-gate"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog"
import { Button } from "./ui/button"
import { Textarea } from "./ui/textarea"
import { UpdateDialog } from "./update-dialog"

// Payload types are derived from the RPC surface so the server stays the single
// source of truth for the gate shapes (no client-side copy to drift).
type Ok<T> = T extends { success: true; data: infer D } ? D : never
type Gate = Ok<Awaited<ReturnType<typeof rpc.gates.listWaiting>>>[number]

function HeldIssues({ gate, onOpenBead }: { gate: Gate; onOpenBead: (id: string) => void }) {
  if (gate.held.length === 0) {
    return <p className="text-xs text-muted-foreground">Holds no open issues.</p>
  }
  return (
    <ul className="space-y-1">
      {gate.held.map((issue) => (
        <li key={issue.id} className={cn("flex items-baseline gap-2 text-sm", issue.via && "pl-4")}>
          <button
            type="button"
            className="font-mono text-xs hover:underline shrink-0"
            onClick={() => onOpenBead(issue.id)}
          >
            {issue.id}
          </button>
          <span className="truncate">{issue.title}</span>
          <span className="text-[11px] text-muted-foreground shrink-0">
            {issue.issueType}
            {issue.via ? ` · via ${issue.via}` : ""}
          </span>
        </li>
      ))}
    </ul>
  )
}

function GateCard({
  gate,
  onOpenBead,
  onResolve,
}: {
  gate: Gate
  onOpenBead: (id: string) => void
  onResolve: (gate: Gate) => void
}) {
  const awaitText = describeAwait(gate.awaitId)
  return (
    <li className="rounded-md border border-border px-4 py-3 space-y-2" data-testid="waiting-gate">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "text-[11px] px-2 py-0.5 rounded-full border",
                gateTypeClass(gate.awaitType),
              )}
            >
              {gateTypeLabel(gate.awaitType)}
            </span>
            <button
              type="button"
              className="font-mono text-xs text-muted-foreground hover:underline"
              onClick={() => onOpenBead(gate.id)}
            >
              {gate.id}
            </button>
            <span className="font-medium truncate">{gate.title}</span>
          </div>
          {gate.description ? (
            <p className="text-sm text-muted-foreground whitespace-pre-line">{gate.description}</p>
          ) : null}
        </div>
        {gate.awaitType === "human" ? (
          <Button size="sm" variant="outline" onClick={() => onResolve(gate)}>
            Resolve
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span title={gate.createdAt}>waiting since {waitingSince(gate.createdAt)}</span>
        {gate.deadline ? (
          <span title={gate.deadline}>{describeDeadline(gate.deadline)}</span>
        ) : null}
        {awaitText ? <span>{awaitText}</span> : null}
      </div>
      <HeldIssues gate={gate} onOpenBead={onOpenBead} />
    </li>
  )
}

function WaitingBody({
  isLoading,
  isError,
  error,
  gates,
  onOpenBead,
  onResolve,
  onBackToBeads,
}: {
  isLoading: boolean
  isError: boolean
  error: unknown
  gates: Gate[]
  onOpenBead: (id: string) => void
  onResolve: (gate: Gate) => void
  onBackToBeads: () => void
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading gates
      </div>
    )
  }
  if (isError) {
    return (
      <p className="text-destructive">
        Could not load gates: {error instanceof Error ? error.message : "unknown error"}
      </p>
    )
  }
  if (gates.length === 0) {
    // Reached when the last gate resolves while the view is open: the tab
    // itself is gone by then, so offer the way back.
    return (
      <div className="space-y-2" data-testid="waiting-empty">
        <p className="text-muted-foreground">Nothing is waiting</p>
        <Button size="sm" variant="outline" onClick={onBackToBeads}>
          Back to Beads
        </Button>
      </div>
    )
  }
  return (
    <ul className="space-y-3">
      {gates.map((gate) => (
        <GateCard key={gate.id} gate={gate} onOpenBead={onOpenBead} onResolve={onResolve} />
      ))}
    </ul>
  )
}

/**
 * Confirm, then run `bd gate resolve` through the server. On success the list
 * and the tab's presence are refetched; the change subscription would also
 * invalidate them, but the user should not wait for the poll to see the gate
 * go. A rejected call refetches too: on a handler timeout bd may still have
 * closed the gate.
 */
function ResolveGateDialog({
  gate,
  dbPath,
  onClose,
  onRefresh,
}: {
  gate: Gate | null
  dbPath: string | undefined
  onClose: () => void
  onRefresh: () => Promise<unknown>
}) {
  const [reason, setReason] = useState("")
  const [isResolving, setIsResolving] = useState(false)

  const confirm = async (event: React.MouseEvent) => {
    // Keep the dialog open while bd runs; it closes once the call returns.
    event.preventDefault()
    if (!gate) return
    setIsResolving(true)
    let result: Awaited<ReturnType<typeof rpc.gates.resolveHumanGate>>
    try {
      result = await trackedAction("resolveHumanGate", () =>
        rpc.gates.resolveHumanGate(gate.id, dbPath, reason),
      )
    } catch (error) {
      // A rejected call (timeout, dropped connection) must not leave the
      // dialog stuck with its buttons disabled.
      toastError("Failed to resolve gate", {
        description: error instanceof Error ? error.message : String(error),
      })
      void onRefresh()
      return
    } finally {
      setIsResolving(false)
    }
    if (!result.success) {
      toastError("Failed to resolve gate", { description: result.error })
      return
    }
    toast.success(`Gate ${gate.id} resolved`)
    setReason("")
    onClose()
    await onRefresh()
  }

  return (
    <AlertDialog
      open={gate !== null}
      onOpenChange={(open) => {
        if (!open && !isResolving) {
          setReason("")
          onClose()
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Resolve gate {gate?.id}?</AlertDialogTitle>
          <AlertDialogDescription>
            This runs bd gate resolve and closes the gate. Anything it holds
            {gate && gate.held.length > 0 ? ` (${gate.held.length} open)` : ""} is released once it
            has no other blockers.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          aria-label="Reason (optional)"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={isResolving}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isResolving}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={isResolving}>
            {isResolving ? "Resolving..." : "Resolve"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function WaitingPage() {
  const { workspaces } = useWorkspaceGate()
  const navigate = useNavigate()
  const { health: appHealth } = useAppHealth()
  const prefs = usePreferences()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [resolving, setResolving] = useState<Gate | null>(null)
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

  // Follows the workspace rail: a project switch rewrites the cookie.
  const [currentWorkspace] = useActiveWorkspace(workspaces)
  const dbPath = currentWorkspace?.databasePath
  const { query, gates } = useWaitingGates(dbPath)
  const refreshWaiting = useRefreshWaiting(dbPath)

  // A gate picked in one workspace must not be resolved against another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a workspace switch
  useEffect(() => setResolving(null), [dbPath])

  const openBead = (id: string) => {
    persistSelectedBead(id)
    void navigate({ to: "/" })
  }

  // ⌘1–⌘6 view switching. This page is open, so Waiting counts as present.
  const hasTrains = useHasTrains(dbPath)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      tryViewSwitchShortcut(e, {
        push: (to) => void navigate({ to: to as never }),
        hasTrains,
        hasWaiting: true,
      })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate, hasTrains])

  return (
    <div className="h-full flex flex-col bg-background safe-area-inset">
      <Header
        currentWorkspace={
          currentWorkspace || { id: "", name: "Loading...", mode: "embedded" as const }
        }
        isRefreshing={query.isFetching}
        isPending={query.isLoading}
        appHealth={appHealth}
        onRefresh={() => void refreshWaiting()}
        updateAvailable={updateAvailable}
        onUpdateClick={() => setUpdateDialogOpen(true)}
        onSettingsOpen={() => setSettingsOpen(true)}
      />

      <main className="flex-1 overflow-y-auto mx-auto w-full max-w-6xl px-6 py-6 space-y-6">
        <div className="flex items-center gap-2">
          <Hourglass className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Waiting</h1>
          <span className="text-sm text-muted-foreground">
            Open gates, oldest first, and the work they hold back from bd ready.
          </span>
        </div>
        <WaitingBody
          // isPending, not isLoading: before the workspace resolves the query
          // is disabled with no data, and must not read as "Nothing is waiting".
          isLoading={query.isPending}
          isError={query.isError}
          error={query.error}
          gates={gates}
          onOpenBead={openBead}
          onResolve={setResolving}
          onBackToBeads={() => void navigate({ to: "/" })}
        />
      </main>

      <ResolveGateDialog
        gate={resolving}
        dbPath={dbPath}
        onClose={() => setResolving(null)}
        onRefresh={refreshWaiting}
      />

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
