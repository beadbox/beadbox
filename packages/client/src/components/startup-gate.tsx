// P3.1 port of components/startup-gate.tsx.
// Source-divergence:
//   - next/navigation { useRouter, usePathname } → @tanstack/react-router
//     { useRouter, useRouterState }; pathname read via useRouterState
//   - router.push(p) → router.navigate({ to: p })
//   - actions/health { runStartupHealth, removeActiveWorkspace,
//     runWorkspaceMigration } → rpc.health.*
//   - actions/workspaces.setServerPassword → rpc.workspaces.setServerPassword
//
// The BdHealthContext export is preserved verbatim — settings-dialog and any
// future health-aware chrome consume it via useBdHealth().

import { useRouter, useRouterState } from "@tanstack/react-router"
import { Circle, ExternalLink, RefreshCw, X } from "lucide-react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react"
import { useUpdateChecker } from "../hooks/use-update-checker"
import { getAnalyticsEnabled } from "../lib/local-storage"
import { safeCapture } from "../lib/posthog-safe"
import { rpc } from "../lib/rpc"
import type { HealthError } from "../lib/startup-machine"
import { INITIAL_STATE, transition } from "../lib/startup-machine"
import { deleteCredential, storeCredential } from "../lib/tauri-credentials"
import type { Workspace } from "../lib/types"
import { cn } from "../lib/utils"
import {
  getWorkspaceCookie,
  isValidWorkspaceCookie,
  setWorkspaceCookie,
  subscribeWorkspaceCookie,
} from "../lib/workspace-cookie"
import { CopyableCommand } from "./copyable-command"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { UpdateDialog } from "./update-dialog"

// ---------------------------------------------------------------------------
// BdHealthContext (preserved for consumers: settings-dialog, page.tsx, etc.)
//
// bb-93xp (port of bb-d4kr): the reportBdError / reportWsReconnected
// callbacks were removed along with the mid-session "Lost connection to
// bd CLI" yellow banner. The banner fired on transient WS/polling blips
// and covered the top of the app with a Retry button. Real bd failures
// still surface through action error toasts and the AppHealth status
// surface — the banner was redundant clutter.
// ---------------------------------------------------------------------------

interface BdHealthContextType {
  bdVersion?: string
  bdPath?: string
  platform: string
}

const BdHealthContext = createContext<BdHealthContextType>({
  platform: "darwin",
})

export function useBdHealth() {
  return useContext(BdHealthContext)
}

// ---------------------------------------------------------------------------
// WorkspaceGateContext (workspace list from startup health check)
// ---------------------------------------------------------------------------

interface WorkspaceGateContextType {
  workspaces: Workspace[]
  refreshWorkspaces: () => void
}

// bb-onv3.2: exported so the change-subscription-mount regression test can
// wrap in a Provider with mock workspaces. Production consumers use
// useWorkspaceGate(); the context is internal but the provider surface is
// shared with the test harness.
export const WorkspaceGateContext = createContext<WorkspaceGateContextType>({
  workspaces: [],
  refreshWorkspaces: () => {},
})

export function useWorkspaceGate() {
  return useContext(WorkspaceGateContext)
}

// ---------------------------------------------------------------------------
// StartupGate
// ---------------------------------------------------------------------------

interface StartupGateProps {
  children: React.ReactNode
}

type StartupHealthResult = Awaited<ReturnType<typeof rpc.health.runStartupHealth>>

export function StartupGate({ children }: StartupGateProps) {
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [state, dispatch] = useReducer(transition, INITIAL_STATE)

  // Track which workspace ID was checked (for removal on stale workspace errors)
  const [checkedWorkspaceId, setCheckedWorkspaceId] = useState<string | undefined>()

  // Forces a re-entry of the health-check effect when the phase alone cannot
  // express it: a switch that lands mid-check ends with the machine back in
  // "checking", i.e. the same phase the effect already ran for.
  const [checkNonce, setCheckNonce] = useState(0)

  // Fallback for no_registry redirect: if router.push doesn't navigate within 3s,
  // show a clickable link so the user isn't stuck on an infinite spinner.
  const [showRedirectFallback, setShowRedirectFallback] = useState(false)

  // Track the workspace cookie value that was last health-checked.
  // Used to detect workspace switches (e.g., /workspaces -> /) without
  // re-checking on every route change.
  const lastCheckedCookieRef = useRef<string | null>(null)

  // Session cache of workspaces whose startup health check already passed.
  // Switching back to one of them skips the check: the machine stays
  // "healthy", children stay mounted, and no full-screen "Starting up..."
  // flashes between projects. Only an app restart clears it — and a
  // workspace that breaks after being verified still surfaces through the
  // page-level load error path (AppHealth / WorkspaceErrorScreen), which is
  // where every mid-session bd failure already lands.
  const verifiedWorkspacesRef = useRef<Set<string>>(new Set())
  // Latest registry list, readable from the cookie listener's closure.
  const workspacesRef = useRef<Workspace[]>([])

  // Tool version info (fetched after healthy)
  const [serverPlatform, setServerPlatform] = useState<string>("darwin")
  const [bdVersion, setBdVersion] = useState<string | undefined>()
  const [bdPath, setBdPath] = useState<string | undefined>()

  // Boot on mount
  useEffect(() => {
    dispatch({ type: "BOOT" })
  }, [])

  // Telemetry: emit app_startup_phase whenever the state machine transitions.
  // Makes state-trap bugs (like bb-g4sz) visible in PostHog: if a user's
  // last phase event before going silent was no_registry, we know they're
  // stuck in the state machine, not in a downstream load failure.
  const lastPhaseRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastPhaseRef.current === state.phase) return
    lastPhaseRef.current = state.phase
    if (getAnalyticsEnabled()) {
      safeCapture("app_startup_phase", {
        phase: state.phase,
        pathname,
        cookie_present: !!getWorkspaceCookie(),
      })
    }
  }, [state.phase, pathname])

  // Run health check when phase === "checking"
  useEffect(() => {
    // Retrying increments this nonce to rerun the health check in the same phase.
    void checkNonce
    if (state.phase !== "checking") return
    let cancelled = false

    // Success half of the check, split out to keep `check` readable: record
    // what was verified, publish the versions, and hand the machine over.
    function acceptHealthy(result: StartupHealthResult, cookieId: string | null) {
      // Sync cookie if needed
      if (result.activeWorkspaceId && result.activeWorkspaceId !== cookieId) {
        setWorkspaceCookie(result.activeWorkspaceId)
      }

      // Record the workspace this check actually covered — NOT the live
      // cookie. The rail is mounted outside this gate, so the user can
      // switch projects while "Starting up..." is on screen; reading the
      // cookie here would mark the *new* workspace verified on the strength
      // of the old one's check and then skip its health check for the rest
      // of the session.
      const checkedId = result.activeWorkspaceId ?? cookieId ?? null
      lastCheckedCookieRef.current = checkedId
      if (checkedId) verifiedWorkspacesRef.current.add(checkedId)

      // Use version info from health check (avoids 2 redundant process spawns)
      if (result.bdVersion) setBdVersion(result.bdVersion)
      if (result.bdPath) setBdPath(result.bdPath)

      dispatch({ type: "HEALTH_OK", workspaces: result.workspaces })
      // A switch that landed mid-check needs its own check: HEALTH_OK then
      // WORKSPACE_CHANGED leaves the machine in "checking" again, and the
      // nonce is what makes the effect notice.
      if (getWorkspaceCookie() !== checkedId) {
        dispatch({ type: "WORKSPACE_CHANGED" })
        setCheckNonce((nonce) => nonce + 1)
      }
    }

    async function check() {
      try {
        const cookieId = getWorkspaceCookie()
        const validCookie = cookieId && isValidWorkspaceCookie(cookieId) ? cookieId : undefined
        const result = await rpc.health.runStartupHealth(validCookie)

        if (cancelled) return

        setServerPlatform(result.platform)

        if (!result.hasWorkspaces) {
          dispatch({ type: "NO_WORKSPACES" })
          return
        }

        // Track which workspace was checked so we can remove it if stale
        if (result.activeWorkspaceId) {
          setCheckedWorkspaceId(result.activeWorkspaceId)
        }

        if (result.healthCheck && !result.healthCheck.ok) {
          // A previously-verified workspace that now fails loses its pass.
          if (cookieId) verifiedWorkspacesRef.current.delete(cookieId)
          dispatch({ type: "HEALTH_FAIL", error: result.healthCheck.error })
          return
        }

        acceptHealthy(result, cookieId)
      } catch (error) {
        if (cancelled) return
        dispatch({
          type: "HEALTH_FAIL",
          error: {
            kind: "unknown",
            message: error instanceof Error ? error.message : String(error),
            bdOutput: "",
          },
        })
      }
    }

    check()
    return () => {
      cancelled = true
    }
  }, [state.phase, checkNonce])

  // Redirect to /workspaces when no registry
  useEffect(() => {
    if (state.phase === "no_registry") {
      router.navigate({ to: "/workspaces" as never })
      const timer = setTimeout(() => setShowRedirectFallback(true), 3000)
      return () => clearTimeout(timer)
    }
    setShowRedirectFallback(false)
  }, [state.phase, router])

  // Signal that startup gate is ready (versions already set from health check result)
  useEffect(() => {
    if (state.phase !== "healthy") return
    window.dispatchEvent(new Event("startup-gate-ready"))
  }, [state.phase])

  // Keep the registry list readable from the cookie listener below.
  useEffect(() => {
    workspacesRef.current = state.workspaces
  }, [state.workspaces])

  // Mid-session health: driven by WebSocket signals from child pages
  // (home-page, activity-page route WS / polling state into the
  // AppHealth status surface). No polling needed here.

  // Returns true when the cookie now points at a workspace this session
  // already health-checked (and which is still in the registry list the
  // gate handed to the pages). The switch is then adopted silently: no
  // WORKSPACE_CHANGED, no re-check, no unmounting of children — the pages
  // pick the new workspace up from the same cookie event.
  const adoptCachedSwitch = useCallback((cookie: string | null): boolean => {
    if (!cookie || !verifiedWorkspacesRef.current.has(cookie)) return false
    if (!workspacesRef.current.some((w) => w.id === cookie)) return false
    lastCheckedCookieRef.current = cookie
    return true
  }, [])

  // Detect workspace cookie changes on route navigation.
  // Two scenarios:
  // 1. healthy: user switched workspace on /workspaces and came back. The
  //    cookie differs from what was last health-checked. Re-run health.
  // 2. no_registry: a NEW user just added their first workspace. The cookie
  //    now exists where it didn't before. Without this transition, the
  //    state machine is trapped in no_registry and the render redirects
  //    back to /workspaces forever (bb-g4sz: 21% of v0.23.2 users stuck
  //    on first-workspace-add flow).
  useEffect(() => {
    if (state.phase === "healthy") {
      const currentCookie = getWorkspaceCookie()
      if (lastCheckedCookieRef.current !== null && currentCookie !== lastCheckedCookieRef.current) {
        if (adoptCachedSwitch(currentCookie)) return
        dispatch({ type: "WORKSPACE_CHANGED" })
      }
      return
    }
    // no_registry escape: new user added a workspace. Cookie now exists,
    // and we've navigated away from /workspaces (so the bypass no longer
    // hides this state). Re-check health to discover the new workspace.
    if (state.phase === "no_registry" && pathname !== "/workspaces") {
      const currentCookie = getWorkspaceCookie()
      if (currentCookie) {
        dispatch({ type: "WORKSPACE_CHANGED" })
      }
    }
  }, [state.phase, pathname, adoptCachedSwitch])

  // Workspace-rail switches happen without a route change: the rail writes
  // the cookie and nothing else. The effect above only samples the cookie on
  // [state.phase, pathname] transitions, so subscribe to the cookie itself
  // and re-run the health check for the newly-active workspace.
  //
  // Loop safety: the health check's own activeWorkspaceId sync (setWorkspaceCookie
  // above) fires this listener while phase === "checking", and the machine
  // ignores WORKSPACE_CHANGED in that phase. The `error` phase only accepts
  // RETRY — without that branch a user could never switch away from a
  // workspace whose health check fails.
  const phaseRef = useRef(state.phase)
  useEffect(() => {
    phaseRef.current = state.phase
  }, [state.phase])

  useEffect(
    () =>
      subscribeWorkspaceCookie(() => {
        const cookie = getWorkspaceCookie()
        if (cookie === lastCheckedCookieRef.current) return
        if (phaseRef.current === "healthy" && adoptCachedSwitch(cookie)) return
        dispatch({ type: phaseRef.current === "error" ? "RETRY" : "WORKSPACE_CHANGED" })
      }),
    [adoptCachedSwitch],
  )

  const refreshWorkspaces = useCallback(() => {
    dispatch({ type: "WORKSPACE_CHANGED" })
  }, [])

  // --- Render ---

  // Bypass: /workspaces has its own workspace management flow and must render
  // even when the gate hasn't reached "healthy" (e.g., first launch with no workspaces,
  // or error state where the user needs to manage workspaces).
  // Wrap in context providers so useBdHealth/useWorkspaceGate don't throw.
  if (pathname === "/workspaces") {
    return (
      <BdHealthContext.Provider value={{ bdVersion, bdPath, platform: serverPlatform }}>
        <WorkspaceGateContext.Provider value={{ workspaces: state.workspaces, refreshWorkspaces }}>
          {children}
        </WorkspaceGateContext.Provider>
      </BdHealthContext.Provider>
    )
  }

  if (state.phase === "idle" || state.phase === "checking") {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin" />
          <span>Starting up...</span>
        </div>
      </div>
    )
  }

  if (state.phase === "no_registry") {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-background gap-4">
        <div className="flex items-center gap-3 text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin" />
          <span>Loading workspace selector...</span>
        </div>
        {showRedirectFallback && (
          <button
            onClick={() => router.navigate({ to: "/workspaces" as never })}
            className="text-sm text-primary hover:underline"
          >
            Go to workspace selector
          </button>
        )}
      </div>
    )
  }

  if (state.phase === "error" && state.error) {
    const handleRemoveWorkspace = async () => {
      if (!checkedWorkspaceId) return
      const result = await rpc.health.removeActiveWorkspace(checkedWorkspaceId)
      if (result.credentialKey) {
        await deleteCredential(result.credentialKey)
      }
      setCheckedWorkspaceId(undefined)
      dispatch({ type: "RETRY" })
    }

    return (
      <ErrorScreen
        error={state.error}
        platform={serverPlatform}
        onRetry={() => dispatch({ type: "RETRY" })}
        onRemoveWorkspace={checkedWorkspaceId ? handleRemoveWorkspace : undefined}
      />
    )
  }

  // phase === "healthy"
  return (
    <BdHealthContext.Provider value={{ bdVersion, bdPath, platform: serverPlatform }}>
      <WorkspaceGateContext.Provider value={{ workspaces: state.workspaces, refreshWorkspaces }}>
        {children}
      </WorkspaceGateContext.Provider>
    </BdHealthContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// ErrorScreen - single component for all HealthError kinds
// ---------------------------------------------------------------------------

const beadDots = [
  { size: "h-4 w-4", opacity: "opacity-100" },
  { size: "h-3.5 w-3.5", opacity: "opacity-90" },
  { size: "h-3 w-3", opacity: "opacity-70" },
  { size: "h-2.5 w-2.5", opacity: "opacity-50" },
  { size: "h-2 w-2", opacity: "opacity-35" },
]

function SetupLogo() {
  return (
    <div className="flex items-center gap-[3px] mb-6 justify-center">
      {beadDots.map((dot, i) => (
        <Circle key={i} className={cn("fill-primary text-primary", dot.size, dot.opacity)} />
      ))}
    </div>
  )
}

interface ErrorScreenProps {
  error: HealthError
  platform: string
  onRetry: () => void
  onRemoveWorkspace?: () => Promise<void>
}

const hasRecoveryActions = (kind: HealthError["kind"]) =>
  kind === "database_missing" || kind === "server_unreachable" || kind === "access_denied"

function errorTitle(error: HealthError): string {
  switch (error.kind) {
    case "bd_missing":
      return "Welcome to Beadbox"
    case "bd_outdated":
      return "bd needs an update"
    case "bd_version_too_old":
      return "bd needs an update"
    case "access_denied":
      return "Authentication required"
    case "server_unreachable":
      return "Database server unreachable"
    case "database_missing":
      return "Database not found"
    case "schema_migration_needed":
      return "Workspace needs a database update"
    case "timeout":
      return "Connection timed out"
    case "unknown":
      return "Startup error"
  }
}

function ErrorScreen({ error, platform, onRetry, onRemoveWorkspace }: ErrorScreenProps) {
  const router = useRouter()
  const [retrying, setRetrying] = useState(false)
  const [removing, setRemoving] = useState(false)
  const retryRef = useRef<HTMLButtonElement>(null)
  const isWindows = platform === "win32"
  const isLinux = platform === "linux"

  const { updateAvailable, dismissUpdate } = useUpdateChecker()
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  useEffect(() => {
    retryRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        router.navigate({ to: "/workspaces" as never })
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [router])

  const handleRetry = async () => {
    setRetrying(true)
    await onRetry()
    setRetrying(false)
  }

  const handleRemove = async () => {
    if (!onRemoveWorkspace) return
    setRemoving(true)
    await onRemoveWorkspace()
    // After removal, startup gate re-checks. If no workspaces remain,
    // it transitions to no_registry and redirects to /workspaces.
    setRemoving(false)
  }

  const busy = retrying || removing

  return (
    <div className="h-full flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full rounded-lg border border-border bg-card p-8 shadow-lg relative">
        <button
          onClick={() => router.navigate({ to: "/workspaces" as never })}
          className={cn(
            "absolute top-3 right-3 inline-flex items-center justify-center rounded-md h-8 w-8",
            "text-muted-foreground/60 hover:text-foreground hover:bg-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "transition-colors",
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Dismiss</span>
        </button>
        <SetupLogo />
        <p className="text-xs text-muted-foreground text-center mb-4">
          v{import.meta.env.VITE_APP_VERSION}
        </p>
        <h1 className="text-xl font-semibold text-foreground text-center mb-2">
          {errorTitle(error)}
        </h1>

        <ErrorGuidance
          error={error}
          isWindows={isWindows}
          isLinux={isLinux}
          onRetry={handleRetry}
        />

        <div className="flex items-center justify-center gap-3 mt-6">
          {error.kind !== "access_denied" && (
            <button
              ref={retryRef}
              onClick={handleRetry}
              disabled={busy}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium min-h-[44px]",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:opacity-50 disabled:pointer-events-none",
                "transition-colors",
              )}
            >
              {retrying && <RefreshCw className="h-4 w-4 animate-spin" />}
              Retry
            </button>
          )}
          {hasRecoveryActions(error.kind) && onRemoveWorkspace && (
            <button
              onClick={handleRemove}
              disabled={busy}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium min-h-[44px]",
                "border border-border text-muted-foreground hover:text-foreground hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:opacity-50 disabled:pointer-events-none",
                "transition-colors",
              )}
            >
              {removing && <RefreshCw className="h-4 w-4 animate-spin" />}
              Remove workspace
            </button>
          )}
          {hasRecoveryActions(error.kind) && (
            <button
              onClick={() => router.navigate({ to: "/workspaces" as never })}
              disabled={busy}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium min-h-[44px]",
                "text-muted-foreground hover:text-foreground hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:opacity-50 disabled:pointer-events-none",
                "transition-colors",
              )}
            >
              Choose workspace
            </button>
          )}
          {error.kind === "bd_missing" && (
            <a
              href="https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a"
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium min-h-[44px]",
                "text-muted-foreground hover:text-foreground hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "transition-colors",
              )}
            >
              What is beads?
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>

        {updateAvailable && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 mt-6">
            <span className="text-sm text-foreground">
              Beadbox v{updateAvailable.version} is available
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setUpdateDialogOpen(true)}
              className="shrink-0"
            >
              Update
            </Button>
          </div>
        )}
      </div>

      {updateAvailable && (
        <UpdateDialog
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          updateInfo={updateAvailable}
          onDismiss={dismissUpdate}
          currentVersion={import.meta.env.VITE_APP_VERSION || "0.0.0"}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Platform-aware install/upgrade instructions
// ---------------------------------------------------------------------------

interface PlatformFlags {
  isWindows: boolean
  isLinux: boolean
}

function BdInstallInstructions({ isWindows, isLinux }: PlatformFlags) {
  if (isWindows) {
    return (
      <div className="flex justify-center mb-2">
        <a
          href="https://github.com/steveyegge/beads/releases/latest"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex items-center gap-1.5 px-4 py-2.5 rounded-md text-sm font-medium",
            "bg-muted/50 border border-border text-foreground hover:bg-accent",
            "transition-colors",
          )}
        >
          Download bd for Windows
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    )
  }
  if (isLinux) {
    return (
      <CopyableCommand
        command="go install github.com/steveyegge/beads/cmd/bd@latest"
        className="mb-3"
      />
    )
  }
  return <CopyableCommand command="brew install beads" className="mb-3" />
}

function BdUpgradeInstructions({ isWindows, isLinux }: PlatformFlags) {
  if (isWindows) {
    return (
      <div className="flex justify-center mb-2">
        <a
          href="https://github.com/steveyegge/beads/releases/latest"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex items-center gap-1.5 px-4 py-2.5 rounded-md text-sm font-medium",
            "bg-muted/50 border border-border text-foreground hover:bg-accent",
            "transition-colors",
          )}
        >
          Download latest bd for Windows
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    )
  }
  if (isLinux) {
    return (
      <CopyableCommand
        command="go install github.com/steveyegge/beads/cmd/bd@latest"
        className="mb-3"
      />
    )
  }
  return <CopyableCommand command="brew upgrade beads" className="mb-3" />
}

// ---------------------------------------------------------------------------
// AccessDeniedGuidance - re-auth form for MySQL 1045 errors
// ---------------------------------------------------------------------------

function AccessDeniedGuidance({
  error,
  onRetry,
}: {
  error: Extract<HealthError, { kind: "access_denied" }>
  onRetry: () => void
}) {
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleReAuth = async () => {
    if (!password.trim()) return
    setSubmitting(true)
    setAuthError(null)
    try {
      await rpc.workspaces.setServerPassword(error.passwordMapKey, password)
      await storeCredential(error.credentialKey, password)
      onRetry()
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !submitting && password.trim()) {
      handleReAuth()
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground text-center">
        The database server at {error.host}:{error.port} rejected the credentials for{" "}
        <span className="font-medium text-foreground">{error.user}</span> on database{" "}
        <span className="font-medium text-foreground">{error.database}</span>.
      </p>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Username</label>
          <Input value={error.user} disabled className="bg-muted/50" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Password</label>
          <Input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter password"
            disabled={submitting}
          />
        </div>
        {authError && <p className="text-xs text-destructive">{authError}</p>}
        <Button onClick={handleReAuth} disabled={submitting || !password.trim()} className="w-full">
          {submitting && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
          Re-authenticate
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SchemaMigrationGuidance - run `bd migrate` for a pre-1.0.1 workspace
// ---------------------------------------------------------------------------

function SchemaMigrationGuidance({
  error,
  onRetry,
}: {
  error: Extract<HealthError, { kind: "schema_migration_needed" }>
  onRetry: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [migrationError, setMigrationError] = useState<string | null>(null)

  const handleMigrate = async () => {
    setSubmitting(true)
    setMigrationError(null)
    try {
      const result = await rpc.health.runWorkspaceMigration(error.workspacePath)
      if (result.ok) {
        // Re-run health check after successful migration
        onRetry()
      } else {
        setMigrationError(result.error ?? result.stderr ?? "Migration failed")
      }
    } catch (err) {
      setMigrationError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const displayPath = error.workspacePath || "your project directory"

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground text-center mb-2">
        This workspace was created with an older bd version and is missing
        {error.missingColumn ? (
          <>
            {" "}
            the <span className="font-mono text-foreground">{error.missingColumn}</span> column
          </>
        ) : (
          <> recent schema updates</>
        )}
        . Run <span className="font-mono text-foreground">bd migrate</span> to apply pending
        updates.
      </p>
      <CopyableCommand command={`bd migrate --db ${displayPath} --yes`} className="mb-3" />
      {migrationError && (
        <p className="text-xs text-destructive whitespace-pre-wrap">{migrationError}</p>
      )}
      <Button onClick={handleMigrate} disabled={submitting} className="w-full">
        {submitting && <RefreshCw className="h-4 w-4 animate-spin mr-2" />}
        {submitting ? "Running bd migrate..." : "Run bd migrate"}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ErrorGuidance
// ---------------------------------------------------------------------------

function ErrorGuidance({
  error,
  isWindows,
  isLinux,
  onRetry,
}: {
  error: HealthError
  isWindows: boolean
  isLinux: boolean
  onRetry: () => void
}) {
  const platformFlags: PlatformFlags = { isWindows, isLinux }

  switch (error.kind) {
    case "bd_missing":
      return (
        <>
          <p className="text-sm text-muted-foreground text-center mb-2">
            Beadbox is a visual dashboard for the beads issue tracker.
          </p>
          <p className="text-sm text-muted-foreground text-center mb-6">
            To get started, install the bd command-line tool:
          </p>
          <BdInstallInstructions {...platformFlags} />
        </>
      )

    case "bd_version_too_old":
      return (
        <>
          <p className="text-sm text-muted-foreground text-center mb-2">
            bd v{error.required} or later is required. You have v{error.current}.
          </p>
          <p className="text-sm text-muted-foreground text-center mb-6">Please update bd:</p>
          <BdUpgradeInstructions {...platformFlags} />
        </>
      )

    case "bd_outdated":
      return (
        <>
          <p className="text-sm text-muted-foreground text-center mb-6">
            The installed version of bd is too old for this version of Beadbox. Please update bd to
            the latest version:
          </p>
          <BdUpgradeInstructions {...platformFlags} />
        </>
      )

    case "access_denied":
      return <AccessDeniedGuidance error={error} onRetry={onRetry} />

    case "server_unreachable":
      return (
        <p className="text-sm text-muted-foreground text-center mb-2">
          Could not connect to the Dolt server
          {error.port ? (
            <>
              {" "}
              at {error.host}:{error.port}
            </>
          ) : (
            <> at {error.host}</>
          )}
          . If this workspace is from a previous session, you can remove it and choose a different
          one.
        </p>
      )

    case "database_missing":
      return (
        <p className="text-sm text-muted-foreground text-center mb-2">
          Database &ldquo;{error.database}&rdquo; does not exist on the server. This usually means
          the workspace entry is stale. You can remove it and choose a different workspace.
        </p>
      )

    case "schema_migration_needed":
      return <SchemaMigrationGuidance error={error} onRetry={onRetry} />

    case "timeout":
      return (
        <p className="text-sm text-muted-foreground text-center mb-2">
          The health check timed out. The database server may be overloaded or unreachable.
        </p>
      )

    case "unknown":
      return (
        <pre className="text-sm text-muted-foreground text-center mb-2 whitespace-pre-wrap font-sans">
          {error.message}
        </pre>
      )
  }
}

// bb-93xp (port of bb-d4kr): the BdErrorBanner component + its
// "Lost connection to bd CLI" copy were removed because the banner
// fired on transient WS/polling blips and covered the top of the app
// with a Retry button. Real bd failures still surface through action
// error toasts and the AppHealth status surface.
