// P3.1 port of components/header.tsx.
// Source-divergence:
//   - next/navigation { useRouter, usePathname } → @tanstack/react-router
//     { useRouter, useRouterState }; pathname read via useRouterState
//   - router.push(path) → router.navigate({ to: path })
//
// Change-subscription discipline (per arch §5 + bb-cqpc.4): Header does NOT
// mount its own subscription. The single useChangeSubscription lives in
// __root.tsx and drives invalidations via TanStack Query; Header reads
// derived state from props (AppHealth, UpdateInfo, Workspace) the same way
// the Next.js source does.

import { useRouter, useRouterState } from "@tanstack/react-router"
import {
  Activity,
  ArrowLeft,
  ArrowUpCircle,
  Circle,
  FlaskConical,
  Heart,
  Loader2,
  RefreshCw,
  ServerCrash,
  Settings,
  TrainFront,
} from "lucide-react"
import { Fragment, useCallback, useEffect, useState } from "react"
import { useHasTrains } from "@/hooks/use-has-trains"
import { safeCapture } from "@/lib/posthog-safe"
import type { AppHealth } from "../hooks/use-app-health"
import { useViewport } from "../hooks/use-viewport"
import { ERROR_CATEGORY_TITLES } from "../lib/epic-tree-utils"
import {
  getAnalyticsEnabled,
  getWorkspaceHintDismissed,
  setWorkspaceHintDismissed,
} from "../lib/local-storage"
import { isTauriRuntime } from "../lib/rpc"
import type { Workspace } from "../lib/types"
import type { UpdateInfo } from "../lib/update-checker"
import { cn } from "../lib/utils"
import { BeadboxLogo } from "./beadbox-logo"
import { HelpFab } from "./help-fab"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"
import { WorkspaceErrorScreen } from "./workspace-error-screen"

function BeadboxLogoLoading({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="222 222 580 580"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ opacity: 0.6 }}
    >
      <defs>
        <radialGradient id="marbleBaseLoading" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#5b21b6" />
          <stop offset="1" stopColor="#5b21b6" />
        </radialGradient>
        <clipPath id="marbleClipLoading">
          <circle cx="512" cy="512" r="250" />
        </clipPath>
      </defs>
      <circle cx="512" cy="512" r="285" fill="#242a35">
        <animate attributeName="opacity" values="1;0.5;1" dur="1.5s" repeatCount="indefinite" />
      </circle>
      <g transform="translate(512, 512) scale(1.14) translate(-512, -512)">
        <circle cx="512" cy="512" r="250" fill="url(#marbleBaseLoading)">
          <animate attributeName="opacity" values="1;0.5;1" dur="1.5s" repeatCount="indefinite" />
        </circle>
        <g clipPath="url(#marbleClipLoading)">
          <path
            d="M220 432c80-130 400-180 620-100"
            fill="none"
            stroke="#ff3b3b"
            strokeWidth="110"
            opacity="0.90"
            strokeLinecap="round"
          />
          <path
            d="M200 502c110-130 420-160 660-70"
            fill="none"
            stroke="#ff6b3d"
            strokeWidth="110"
            opacity="0.95"
            strokeLinecap="round"
          />
          <path
            d="M190 572c130-130 460-155 690-50"
            fill="none"
            stroke="#ffd43b"
            strokeWidth="110"
            opacity="0.95"
            strokeLinecap="round"
          />
          <path
            d="M190 642c150-125 480-140 710-30"
            fill="none"
            stroke="#39d353"
            strokeWidth="110"
            opacity="0.95"
            strokeLinecap="round"
          />
          <path
            d="M200 712c160-120 490-130 720-10"
            fill="none"
            stroke="#1d8aff"
            strokeWidth="105"
            opacity="0.95"
            strokeLinecap="round"
          />
          <path
            d="M210 772c170-110 490-115 730 15"
            fill="none"
            stroke="#7c3aed"
            strokeWidth="90"
            opacity="0.8"
            strokeLinecap="round"
          />
        </g>
        <path
          d="M430 342c-40 25-75 70-85 110c40-15 85-45 118-90c12-17 8-35-33-20Z"
          fill="#fff"
          opacity="0.35"
        />
        <path
          d="M380 362 L408 417 L463 445 L408 473 L380 528 L352 473 L297 445 L352 417 Z"
          fill="#ffffff"
          opacity="0.95"
        />
      </g>
    </svg>
  )
}

interface HeaderProps {
  currentWorkspace: Workspace
  loadingWorkspaceId?: string | null
  isPending?: boolean
  isRefreshing?: boolean
  appHealth?: AppHealth
  onRefresh?: () => Promise<void> | void
  updateAvailable?: UpdateInfo | null
  onUpdateClick?: () => void
  versionLabel?: string
  onSettingsOpen?: () => void
  autoRetryCountdown?: number | null
}

export function Header({
  currentWorkspace,
  loadingWorkspaceId,
  isPending,
  isRefreshing,
  appHealth,
  onRefresh,
  updateAvailable,
  onUpdateClick,
  versionLabel,
  onSettingsOpen,
  autoRetryCountdown,
}: HeaderProps) {
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { isMobile, isTablet } = useViewport()
  const [showHint, setShowHint] = useState(false)
  const [healthDetailsOpen, setHealthDetailsOpen] = useState(false)
  const hasTrains = useHasTrains(currentWorkspace.id)

  const navigateTo = useCallback(
    (destination: string, source: "tab" | "dropdown") => {
      const route = destination === "home" ? "/" : `/${destination}`
      if (getAnalyticsEnabled()) {
        safeCapture("app_navigation_used", { destination, source })
      }
      // TanStack Router's navigate accepts a string `to`; we pre-derived `route`
      // above so this is a 1:1 swap from next/navigation router.push().
      void router.navigate({ to: route })
    },
    [router],
  )

  useEffect(() => {
    if (getWorkspaceHintDismissed()) return
    const showTimer = setTimeout(() => setShowHint(true), 1000)
    const autoDismissTimer = setTimeout(() => {
      setShowHint(false)
      setWorkspaceHintDismissed()
    }, 8000)
    return () => {
      clearTimeout(showTimer)
      clearTimeout(autoDismissTimer)
    }
  }, [])

  const dismissHint = useCallback(() => {
    setShowHint(false)
    setWorkspaceHintDismissed()
  }, [])

  return (
    <header className="border-b border-border/50 bg-transparent">
      <div
        className={cn(
          "flex items-center justify-between",
          isMobile ? "px-3 py-[5px]" : isTablet ? "px-4 py-3" : "px-6 py-3",
        )}
      >
        <div
          className={cn(
            "flex items-center min-w-0",
            isMobile ? "gap-3" : isTablet ? "gap-4" : "gap-8",
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  dismissHint()
                  navigateTo("workspaces", "tab")
                }}
                className="group relative flex items-center gap-1.5 min-w-0 px-2 py-1 rounded-md hover:bg-accent/50 transition-colors"
                aria-label="Switch workspace"
              >
                {showHint && (
                  <span
                    className="absolute inset-0 rounded-md pointer-events-none"
                    style={{
                      boxShadow: "0 0 0 2px var(--primary)",
                      animation: "pulse-ring 2s ease-in-out infinite",
                    }}
                    aria-hidden="true"
                  />
                )}
                {/* Default state: small logo + workspace name.
                    Kept in layout on hover (invisible instead of hidden) so the
                    button width stays stable and the hover state can overlay
                    without causing layout thrash / hover flicker. */}
                <span className="flex items-center gap-1.5 min-w-0 group-hover:invisible">
                  {isPending ? (
                    <BeadboxLogoLoading size={22} />
                  ) : currentWorkspace.icon ? (
                    // User-chosen tab emoji (set from the workspace rail)
                    // replaces the marble so the active project reads the
                    // same in the rail and the header.
                    <span className="text-lg leading-none" aria-hidden="true">
                      {currentWorkspace.icon}
                    </span>
                  ) : (
                    <BeadboxLogo size={22} />
                  )}
                  <span
                    className={cn(
                      "text-base font-medium text-foreground truncate",
                      isMobile ? "max-w-[140px]" : "max-w-[200px]",
                    )}
                  >
                    {currentWorkspace.name || "No workspace"}
                  </span>
                  {loadingWorkspaceId === currentWorkspace.id && (
                    <Loader2 className="h-3 w-3 animate-spin shrink-0 text-muted-foreground" />
                  )}
                </span>
                {/* Hover state: back arrow + label. Absolute overlay so it
                    doesn't participate in the button's width calculation. */}
                <span className="absolute inset-0 flex items-center justify-start gap-1 px-2 text-base font-medium text-muted-foreground opacity-0 group-hover:opacity-100">
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {currentWorkspace.databasePath || currentWorkspace.path || currentWorkspace.name}
            </TooltipContent>
          </Tooltip>

          {/* View navigation */}
          {!isMobile && (
            <div className="flex items-center gap-1 ml-4 border-l border-border/50 pl-4">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => navigateTo("home", "tab")}
                    className={cn(
                      "px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors inline-flex items-center gap-1.5",
                      pathname === "/"
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                    )}
                  >
                    <Circle className="h-3.5 w-3.5" />
                    Beads
                  </button>
                </TooltipTrigger>
                <TooltipContent>Beads ⌘1</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => navigateTo("activity", "tab")}
                    className={cn(
                      "px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors inline-flex items-center gap-1.5",
                      pathname === "/activity"
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                    )}
                  >
                    <Activity className="h-3.5 w-3.5" />
                    Activity
                  </button>
                </TooltipTrigger>
                <TooltipContent>Activity ⌘2</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => navigateTo("formulas", "tab")}
                    className={cn(
                      "px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors inline-flex items-center gap-1.5",
                      pathname === "/formulas"
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                    )}
                  >
                    <FlaskConical className="h-3.5 w-3.5" />
                    Formulas
                  </button>
                </TooltipTrigger>
                <TooltipContent>Formulas \u2318\u0033</TooltipContent>
              </Tooltip>
              {hasTrains && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => navigateTo("trains", "tab")}
                      className={cn(
                        "px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors inline-flex items-center gap-1.5",
                        pathname === "/trains"
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                      )}
                    >
                      <TrainFront className="h-3.5 w-3.5" />
                      Trains
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Trains ⌘4</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        <div className={cn("flex items-center", isMobile ? "gap-1" : "gap-2")}>
          <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
            {versionLabel ?? "Beta"}
          </span>
          {onRefresh && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onRefresh?.()}
                  disabled={isRefreshing || isPending}
                  className={cn(
                    "inline-flex items-center justify-center rounded-md",
                    "text-muted-foreground hover:text-foreground hover:bg-accent",
                    "transition-colors",
                    (isRefreshing || isPending) && "pointer-events-none",
                    isMobile ? "min-h-[44px] min-w-[44px]" : "h-9 w-9",
                  )}
                >
                  <RefreshCw
                    className={cn(
                      "h-4 w-4 transition-transform",
                      (isRefreshing || isPending) && "animate-spin",
                    )}
                  />
                  <span className="sr-only">Refresh</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Refresh data</TooltipContent>
            </Tooltip>
          )}
          {updateAvailable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onUpdateClick}
                  className={cn(
                    "relative inline-flex items-center justify-center rounded-md",
                    "text-emerald-400 hover:text-emerald-300 hover:bg-accent",
                    "transition-colors",
                    isMobile ? "min-h-[44px] min-w-[44px]" : "h-9 w-9",
                  )}
                  aria-label={`Update available: v${updateAvailable.version}`}
                >
                  <ArrowUpCircle className="h-4 w-4" />
                  <span className="absolute top-1 right-1 flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Update available: v{updateAvailable.version}</TooltipContent>
            </Tooltip>
          )}
          {appHealth && appHealth.status !== "healthy" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center shrink-0">
                  <span
                    className={cn(
                      "inline-block h-2.5 w-2.5 rounded-full",
                      appHealth.status === "degraded" ? "bg-amber-500" : "bg-red-500",
                    )}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>{"reason" in appHealth ? appHealth.reason : ""}</TooltipContent>
            </Tooltip>
          )}
          {onSettingsOpen && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onSettingsOpen}
                  className={cn(
                    "inline-flex items-center justify-center rounded-md",
                    "text-muted-foreground hover:text-foreground hover:bg-accent",
                    "transition-colors",
                    isMobile ? "min-h-[44px] min-w-[44px]" : "h-9 w-9",
                  )}
                >
                  <Settings className="h-4 w-4" />
                  <span className="sr-only">Settings</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Settings (Cmd+,)</TooltipContent>
            </Tooltip>
          )}
          <HelpFab />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  const url = "https://buy.stripe.com/cNifZgdeAaFF1ou5ry6Na00"
                  if (isTauriRuntime()) {
                    // Tauri WebView: navigate current window; Rust on_navigation
                    // handler intercepts external URLs and opens in system browser.
                    window.location.href = url
                  } else {
                    window.open(url, "_blank", "noopener,noreferrer")
                  }
                }}
                className={cn(
                  "inline-flex items-center justify-center rounded-md",
                  "text-muted-foreground hover:text-foreground hover:bg-accent",
                  "transition-colors",
                  isMobile ? "min-h-[44px] min-w-[44px]" : "h-9 w-9",
                )}
              >
                <Heart className="h-5 w-5" />
                <span className="sr-only">Support Beadbox</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Support Beadbox</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {appHealth &&
        (appHealth.status === "error" || appHealth.status === "fatal") &&
        (() => {
          const loadError = appHealth.loadError
          const summaryMsg =
            loadError && loadError.category !== "unknown"
              ? (ERROR_CATEGORY_TITLES[loadError.category] ?? appHealth.reason)
              : appHealth.reason
          return (
            <Fragment>
              <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-red-500/10 border-t border-red-500/20 text-red-400 text-xs">
                <ServerCrash className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {autoRetryCountdown != null && autoRetryCountdown > 0
                    ? `Retrying automatically... (${autoRetryCountdown}s)`
                    : summaryMsg}
                </span>
                {loadError && (
                  <button
                    onClick={() => setHealthDetailsOpen(true)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors shrink-0"
                  >
                    Details
                  </button>
                )}
                {appHealth.status === "error" && appHealth.canRetry && onRefresh && (
                  <button
                    onClick={() => onRefresh?.()}
                    disabled={isRefreshing}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors shrink-0"
                  >
                    <RefreshCw className={cn("h-3 w-3", isRefreshing && "animate-spin")} />
                    Retry
                  </button>
                )}
              </div>
              {loadError && (
                <Dialog open={healthDetailsOpen} onOpenChange={setHealthDetailsOpen}>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>
                        {ERROR_CATEGORY_TITLES[loadError.category] ?? "Error Details"}
                      </DialogTitle>
                    </DialogHeader>
                    <WorkspaceErrorScreen
                      error={loadError}
                      onRetry={() => {
                        setHealthDetailsOpen(false)
                        onRefresh?.()
                      }}
                      isRetrying={!!isRefreshing}
                      databasePath={currentWorkspace?.databasePath ?? ""}
                    />
                  </DialogContent>
                </Dialog>
              )}
            </Fragment>
          )
        })()}
    </header>
  )
}
