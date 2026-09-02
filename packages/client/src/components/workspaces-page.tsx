// Ported from app/workspaces/page.tsx (P3.2 / bb-90zz.2).
//
// Swap surface (per bead AC):
//   - "use client" directive removed (Vite SPA, no SSR boundary)
//   - useRouter from next/navigation → from @tanstack/react-router
//     (router.push("/?from=selector") → router.navigate({ to: "/", search: { from: "selector" } }))
//   - getRegisteredWorkspacesForSelector / removeWorkspace /
//     setActiveWorkspaceAction → rpc.workspaces.*
//   - checkBdHealth → rpc.health.checkBdHealth
//   - process.env.NEXT_PUBLIC_APP_VERSION → import.meta.env.VITE_APP_VERSION
//   - @/components/* → ./* (relative); @/lib/* → ../lib/*; @/hooks/* → ../hooks/*
//
// Local-state pattern preserved verbatim from the source. The bead PLAN
// guidance about TanStack Query useQuery/useMutation was evaluated against
// the bead's binding "feature parity is the contract — no refactors" rule;
// the source page uses local useState/useCallback, so introducing TanStack
// Query would shift retry/staleTime/focus-refetch semantics. Cross-process
// invalidation lives in __root.tsx's useChangeSubscription (P2.4) and does
// not apply to the registry file (~/.beadbox/registry.json) anyway, so the
// registry-only state on this route stays in sync the same way the Next.js
// page did.

import { useRouter } from "@tanstack/react-router"
import { Circle, ExternalLink, FolderOpen, HardDrive, Loader2, Plus, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useUpdateChecker } from "../hooks/use-update-checker"
import { getAnalyticsEnabled } from "../lib/local-storage"
import { toastError } from "../lib/notifications"
import { safeCapture } from "../lib/posthog-safe"
import { rpc } from "../lib/rpc"
import { useSubscriptionChangeSignal } from "../lib/subscribe"
import type { WorkspaceCard as WorkspaceCardType } from "../lib/types"
import { cn } from "../lib/utils"
import { activateWorkspace, unregisterWorkspace } from "../lib/workspace-actions"
import { clearWorkspaceCookie, getWorkspaceCookie } from "../lib/workspace-cookie"
import { AddWorkspaceDialog } from "./add-workspace-dialog"
import { EditConnectionDialog } from "./edit-connection-dialog"
import { InitWorkspaceDialog } from "./init-workspace-dialog"
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
import { TooltipProvider } from "./ui/tooltip"
import { UpdateDialog } from "./update-dialog"
import { WorkspaceCard } from "./workspace-card"

// ─── Logo ────────────────────────────────────────────────────────────────────

const beadDots = [
  { size: "h-4 w-4", opacity: "opacity-100" },
  { size: "h-3.5 w-3.5", opacity: "opacity-90" },
  { size: "h-3 w-3", opacity: "opacity-70" },
  { size: "h-2.5 w-2.5", opacity: "opacity-50" },
  { size: "h-2 w-2", opacity: "opacity-35" },
]

function SelectorLogo() {
  return (
    <div className="flex items-center gap-[3px] justify-center">
      {beadDots.map((dot, i) => (
        <Circle key={i} className={cn("fill-primary text-primary", dot.size, dot.opacity)} />
      ))}
    </div>
  )
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase = "checking-bd" | "bd-missing" | "loading" | "ready"

const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "0.0.0"

// ─── Bd Missing Screen ──────────────────────────────────────────────────────

function BdMissingScreen({
  onCheckAgain,
  feedback,
  platform,
}: {
  onCheckAgain: () => void
  feedback: string | null
  platform: string
}) {
  const [checking, setChecking] = useState(false)
  const isWindows = platform === "win32"
  const isLinux = platform === "linux"

  const handleCheck = async () => {
    setChecking(true)
    await onCheckAgain()
    setChecking(false)
  }

  return (
    <div className="h-full flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full rounded-lg border border-border bg-card p-8 shadow-lg">
        <div className="mb-6">
          <SelectorLogo />
        </div>
        <p className="text-xs text-muted-foreground text-center mb-4">v{APP_VERSION}</p>
        <h1 className="text-xl font-semibold text-foreground text-center mb-2">
          Welcome to Beadbox
        </h1>
        <p className="text-sm text-muted-foreground text-center mb-2">
          Beadbox is a visual dashboard for the beads issue tracker.
        </p>
        <p className="text-sm text-muted-foreground text-center mb-6">
          To get started, install the bd command-line tool:
        </p>
        {isWindows ? (
          <>
            <p className="text-sm text-muted-foreground text-center mb-4">
              Download the latest Windows release from GitHub and add it to your PATH:
            </p>
            <div className="flex justify-center mb-6">
              <a
                href="https://github.com/steveyegge/beads/releases/latest"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-md text-sm font-medium bg-muted/50 border border-border text-foreground hover:bg-accent transition-colors"
              >
                Download bd for Windows <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
            <p className="text-xs text-muted-foreground text-center mb-6">
              After installing, restart Beadbox for it to detect bd on your PATH.
            </p>
          </>
        ) : isLinux ? (
          <>
            <div className="rounded-md bg-muted/50 border border-border px-4 py-3 mb-3 font-mono text-sm text-foreground select-all break-all">
              go install github.com/steveyegge/beads/cmd/bd@latest
            </div>
            <div className="mb-6" />
          </>
        ) : (
          <>
            <div className="rounded-md bg-muted/50 border border-border px-4 py-3 mb-3 font-mono text-sm text-foreground select-all">
              brew install beads
            </div>
            <div className="mb-6" />
          </>
        )}
        {feedback && <p className="text-sm text-amber-400 text-center mb-4">{feedback}</p>}
        <div className="flex items-center justify-center gap-4">
          <Button onClick={handleCheck} disabled={checking}>
            {checking && <RefreshCw className="h-4 w-4 animate-spin" />}
            Check again
          </Button>
          <a
            href="https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            What is beads? <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  )
}

// Session-level cache: once bd is verified, skip the check on back-navigation.
// Survives client-side route transitions but resets on full page reload.
let bdVerifiedThisSession = false
let cachedPlatform = "darwin"

/** @internal Test-only reset for the session cache. */
export function __resetBdSessionCache() {
  bdVerifiedThisSession = false
  cachedPlatform = "darwin"
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export function WorkspacesPage() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>(bdVerifiedThisSession ? "loading" : "checking-bd")
  const [bdFeedback, setBdFeedback] = useState<string | null>(null)
  const [serverPlatform, setServerPlatform] = useState<string>("darwin")
  const [workspaces, setWorkspaces] = useState<WorkspaceCardType[]>([])
  const [isTauri, setIsTauri] = useState(false)

  // Dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addDialogDefaultTab, setAddDialogDefaultTab] = useState<"local" | "server">("local")
  const [initDialogOpen, setInitDialogOpen] = useState(false)
  const [initDialogPath, setInitDialogPath] = useState<string | undefined>()
  const [removeTarget, setRemoveTarget] = useState<WorkspaceCardType | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [configureTarget, setConfigureTarget] = useState<WorkspaceCardType | null>(null)

  // Update checker
  const { updateAvailable, dismissUpdate } = useUpdateChecker()
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  // Detect Tauri
  useEffect(() => {
    setIsTauri(!!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__)
  }, [])

  // ─── Bd Check ──────────────────────────────────────────────────────────────

  const checkBd = useCallback(async () => {
    const result = await rpc.health.checkBdHealth()
    setServerPlatform(result.platform)
    cachedPlatform = result.platform
    if (!result.bdAvailable) {
      bdVerifiedThisSession = false
      setPhase("bd-missing")
      return false
    }
    bdVerifiedThisSession = true
    return true
  }, [])

  // ─── Workspace Loading ─────────────────────────────────────────────────────

  const loadWorkspaces = useCallback(async () => {
    setPhase("loading")
    try {
      const ws = await rpc.workspaces.getRegisteredWorkspacesForSelector()
      setWorkspaces(ws)
    } catch {
      setWorkspaces([])
    }
    setPhase("ready")
  }, [])

  const handleBdCheckAgain = useCallback(async () => {
    setBdFeedback(null)
    const ok = await checkBd()
    if (!ok) {
      setBdFeedback("bd still not found. Make sure the install completed and try again.")
    } else {
      loadWorkspaces()
    }
  }, [checkBd, loadWorkspaces])

  // Initial load: skip bd check on back-navigation if already verified
  useEffect(() => {
    async function init() {
      if (bdVerifiedThisSession) {
        setServerPlatform(cachedPlatform)
        await loadWorkspaces()
      } else {
        const bdOk = await checkBd()
        if (bdOk) await loadWorkspaces()
      }
    }
    init()
  }, [checkBd, loadWorkspaces])

  // bb-1xi2: pattern replay of bb-hj80. The central useChangeSubscription
  // (mounted in __root.tsx) bumps the subscription change counter on every
  // bd event. /workspaces consumes via this hook; reload the registry on
  // each bump so a `bd init` from outside the SPA appears within 2s without
  // navigation. Skip the initial value (0) so we don't double-fetch on
  // mount; the init() effect above already loaded once. Guard against
  // re-entering during an in-flight load.
  //
  // bb-pnlx (P0 v0.25-rc.3 nav-stall): `phase` MUST NOT be in this effect's
  // deps array. With `phase` as a dep, the effect re-fires on every phase
  // transition. loadWorkspaces() flips phase "ready" → "loading" → "ready",
  // which then re-fires the effect, which calls loadWorkspaces again — an
  // infinite ping-pong that floods the sidecar (matches ops's CPU + IPC
  // saturation findings) and traps the spinner at "Loading workspaces".
  // The loop only kicks in once subscriptionSignal > 0 (so first visits
  // are fine; after any bd event, all subsequent visits to /workspaces
  // hang). Read latest phase via ref to keep the in-flight guard
  // semantically intact while removing the loop trigger.
  const phaseRef = useRef(phase)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const subscriptionSignal = useSubscriptionChangeSignal()
  useEffect(() => {
    if (subscriptionSignal === 0) return
    if (phaseRef.current === "loading" || phaseRef.current === "checking-bd") return
    void loadWorkspaces()
  }, [subscriptionSignal, loadWorkspaces])

  // ─── Workspace Actions ─────────────────────────────────────────────────────

  const handleOpen = useCallback(
    async (ws: WorkspaceCardType) => {
      setConnecting(ws.id)
      try {
        await activateWorkspace(ws)
        router.navigate({ to: "/", search: { from: "selector" } })
      } catch {
        setConnecting(null)
      }
    },
    [router],
  )

  const [isRemoving, setIsRemoving] = useState(false)

  const handleRemove = useCallback(async () => {
    if (!removeTarget || isRemoving) return
    setIsRemoving(true)
    try {
      const result = await unregisterWorkspace(removeTarget, "ui")
      if (result.ok) {
        setWorkspaces((prev) => prev.filter((w) => w.id !== removeTarget.id))
        if (getWorkspaceCookie() === removeTarget.id) clearWorkspaceCookie()
      } else {
        toastError("Failed to remove workspace", { description: result.error })
      }
      setRemoveTarget(null)
    } finally {
      setIsRemoving(false)
    }
  }, [removeTarget, isRemoving])

  const handleWorkspacesAdded = useCallback(
    (added: WorkspaceCardType[], replacedIds?: string[]) => {
      setWorkspaces((prev) => {
        const removedSet = new Set(replacedIds ?? [])
        const filtered = removedSet.size > 0 ? prev.filter((w) => !removedSet.has(w.id)) : prev
        const existingIds = new Set(filtered.map((w) => w.id))
        const newOnly = added.filter((w) => !existingIds.has(w.id))
        return [...filtered, ...newOnly]
      })
      if (getAnalyticsEnabled()) {
        for (const ws of added) {
          safeCapture("app_workspace_added", {
            method: ws.mode === "server" ? "server" : "local",
            success: true,
          })
        }
      }
    },
    [],
  )

  const handleNeedsInit = useCallback((path: string) => {
    setAddDialogOpen(false)
    setInitDialogPath(path)
    setInitDialogOpen(true)
  }, [])

  const handleInitSuccess = useCallback((ws: WorkspaceCardType) => {
    setWorkspaces((prev) => (prev.some((w) => w.id === ws.id) ? prev : [...prev, ws]))
    setInitDialogOpen(false)
    if (getAnalyticsEnabled()) {
      safeCapture("app_workspace_added", { method: "init", success: true })
    }
  }, [])

  const handleConnectionUpdated = useCallback((updated: WorkspaceCardType) => {
    setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
    setConfigureTarget(null)
  }, [])

  const openAddLocal = useCallback(() => {
    setAddDialogDefaultTab("local")
    setAddDialogOpen(true)
  }, [])

  const openAddServer = useCallback(() => {
    setAddDialogDefaultTab("server")
    setAddDialogOpen(true)
  }, [])

  // ─── Render ────────────────────────────────────────────────────────────────

  if (phase === "checking-bd") {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin" />
          <span>Starting up...</span>
        </div>
      </div>
    )
  }

  if (phase === "bd-missing") {
    return (
      <BdMissingScreen
        onCheckAgain={handleBdCheckAgain}
        feedback={bdFeedback}
        platform={serverPlatform}
      />
    )
  }

  if (phase === "loading") {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading workspaces...</span>
        </div>
      </div>
    )
  }

  const hasWorkspaces = workspaces.length > 0

  return (
    <TooltipProvider>
      {/* h-full, not h-dvh: the dashboard renders inside the root shell's
          flex row next to the workspace rail (routes/__root.tsx), and the
          height chain is html/body/#root at 100% (index.css bb-s3gb). */}
      <div className="h-full flex flex-col bg-background">
        {/* Header */}
        <div className="pt-6 pb-3 px-6 text-center">
          <div className="mb-2">
            <SelectorLogo />
          </div>
          <h1 className="text-xl font-semibold text-foreground">
            {hasWorkspaces ? "Select a workspace" : "Welcome to Beadbox"}
          </h1>
          <p className="text-xs text-muted-foreground mt-1">v{APP_VERSION}</p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6">
          {hasWorkspaces ? (
            <div className="max-w-3xl mx-auto">
              {/* Update banner */}
              {updateAvailable && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5 mb-3">
                  <span className="text-sm text-foreground">
                    Beadbox v{updateAvailable.version} is available
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setUpdateDialogOpen(true)}
                    className="shrink-0"
                  >
                    Download
                  </Button>
                </div>
              )}

              {/* Workspace grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {workspaces.map((ws) => (
                  <div key={ws.id} className="relative">
                    {connecting === ws.id && (
                      <div className="absolute inset-0 bg-background/80 rounded-lg flex items-center justify-center z-10">
                        <Loader2 className="h-5 w-5 animate-spin text-primary" />
                      </div>
                    )}
                    <WorkspaceCard
                      workspace={ws}
                      onOpen={handleOpen}
                      onRemove={(w) => setRemoveTarget(w)}
                      onConfigure={(w) => setConfigureTarget(w)}
                    />
                  </div>
                ))}

                {/* Add workspace cards */}
                <button
                  onClick={openAddLocal}
                  className="w-full text-left rounded-lg border-2 border-dashed border-border/60 p-4 hover:border-primary/40 hover:bg-accent/20 transition-colors flex items-center gap-3"
                >
                  <div className="rounded-md bg-muted/50 p-1.5">
                    <Plus className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Add workspace</p>
                    <p className="text-xs text-muted-foreground/70">Browse for a beads project</p>
                  </div>
                </button>
              </div>
              <div className="mt-3 text-center">
                <button
                  onClick={openAddServer}
                  className="text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors"
                >
                  Need to connect to a remote Dolt server?
                </button>
              </div>
            </div>
          ) : (
            /* Empty state */
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
              <p className="text-sm text-muted-foreground mb-6 max-w-md">
                Beadbox is a visual interface for the beads issue tracker. Choose how you want to
                get started.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  onClick={() => {
                    setInitDialogPath(undefined)
                    setInitDialogOpen(true)
                  }}
                >
                  <HardDrive className="h-4 w-4 mr-2" />
                  Init your first workspace
                </Button>
                <Button variant="outline" onClick={openAddLocal}>
                  <FolderOpen className="h-4 w-4 mr-2" />
                  Use existing workspace
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <AddWorkspaceDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onWorkspaceAdded={handleWorkspacesAdded}
        onNeedsInit={handleNeedsInit}
        isTauri={isTauri}
        defaultTab={addDialogDefaultTab}
      />

      <InitWorkspaceDialog
        open={initDialogOpen}
        onOpenChange={setInitDialogOpen}
        onSuccess={handleInitSuccess}
        initialPath={initDialogPath}
        isTauri={isTauri}
      />

      {/* Remove confirmation */}
      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open && !isRemoving) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes &quot;{removeTarget?.name}&quot; from your workspace list. The project
              files and .beads data will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove} disabled={isRemoving}>
              {isRemoving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {isRemoving ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <EditConnectionDialog
        open={!!configureTarget}
        onOpenChange={(open) => {
          if (!open) setConfigureTarget(null)
        }}
        workspace={configureTarget}
        onUpdated={handleConnectionUpdated}
      />

      {updateAvailable && (
        <UpdateDialog
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          updateInfo={updateAvailable}
          onDismiss={dismissUpdate}
          currentVersion={APP_VERSION}
        />
      )}
    </TooltipProvider>
  )
}
