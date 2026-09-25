import type * as DiagnosticsHandlers from "@beadbox/server/handlers"
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CircleX,
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Keyboard,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Stethoscope,
  Trash2,
  X,
} from "lucide-react"
import posthog from "posthog-js"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { ThemeVariant, UpdateCheckFrequency } from "../lib/local-storage"
import { clearCache, getAnalyticsEnabled, setAnalyticsEnabled } from "../lib/local-storage"
import { safeCapture } from "../lib/posthog-safe"
// P3.1 source-divergence:
//   - actions/system { openInFileManager, getLogDirectory } → rpc.system.*
//   - actions/diagnostics { runDiagnostics } → rpc.diagnostics.runDiagnostics
//   - actions/diagnostics types come from packages/server/src/handlers/diagnostics
//     (single source of truth; rpc surface mirrors handler exports)
//   - dynamic import("@/actions/epics") for getCacheStats → rpc.epics.getCacheStats
import { isTauriRuntime, rpc } from "../lib/rpc"
import type { UpdateInfo } from "../lib/update-checker"
import { cn } from "../lib/utils"
import { CustomStatusesManager } from "./custom-statuses-manager"
import { Button } from "./ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible"
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog"

type DiagnosticsResult =
  ReturnType<typeof DiagnosticsHandlers.handlers.diagnostics.runDiagnostics> extends Promise<
    infer T
  >
    ? T
    : never
type DiagnosticCheck = DiagnosticsResult extends { checks: Array<infer C> } ? C : never

import type { VersionCheck } from "../lib/version-requirements"
import { getVersionStatus } from "../lib/version-requirements"
import { useBdHealth } from "./startup-gate"

export type SettingsTab = "general" | "workflow" | "shortcuts" | "help"

const tabs: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "workflow", label: "Workflow", icon: GitBranch },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "help", label: "Help", icon: CircleHelp },
]

const version = import.meta.env.VITE_APP_VERSION ?? "0.0.0"
const buildId = import.meta.env.VITE_BUILD_ID

const THEME_OPTIONS: {
  id: ThemeVariant
  label: string
  colors: {
    bg: string
    card: string
    primary: string
    secondary: string
    muted: string
    fg: string
  }
}[] = [
  {
    id: "blue",
    label: "Blue",
    colors: {
      bg: "#0f172a",
      card: "#1e293b",
      primary: "#22c55e",
      secondary: "#334155",
      muted: "#94a3b8",
      fg: "#f1f5f9",
    },
  },
  {
    id: "gray",
    label: "Gray",
    colors: {
      bg: "#18181b",
      card: "#27272a",
      primary: "#22c55e",
      secondary: "#3f3f46",
      muted: "#a1a1aa",
      fg: "#f4f4f5",
    },
  },
  {
    id: "green",
    label: "Green",
    colors: {
      bg: "#0c1a14",
      card: "#14291e",
      primary: "#34d399",
      secondary: "#1e3a2b",
      muted: "#6ee7b7",
      fg: "#ecfdf5",
    },
  },
]

const FREQUENCY_OPTIONS: { value: UpdateCheckFrequency; label: string }[] = [
  { value: 1800000, label: "Every 30 minutes" },
  { value: 3600000, label: "Every hour" },
  { value: 14400000, label: "Every 4 hours" },
  { value: 86400000, label: "Daily" },
]

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  theme: ThemeVariant
  onThemeChange: (theme: ThemeVariant) => void
  zoomLevel: number
  onZoomChange: (level: number) => void
  databasePath?: string
  workspaceId?: string
  vimNavigationEnabled: boolean
  onVimNavigationChange: (enabled: boolean) => void
  updateCheckEnabled: boolean
  onUpdateCheckEnabledChange: (enabled: boolean) => void
  updateCheckFrequency: UpdateCheckFrequency
  onUpdateCheckFrequencyChange: (frequency: UpdateCheckFrequency) => void
  updateAvailable: UpdateInfo | null
  updateChecking: boolean
  /**
   * Non-null when the last check FAILED. beadbox-l5i.6.4: this must render
   * differently from "no update available" — 0.25.x collapsed the two and told
   * users they were up to date while the fetch was 404ing.
   */
  updateCheckError: string | null
  onCheckForUpdates: () => Promise<void>
  onOpenUpdateDialog?: () => void
  initialTab?: SettingsTab
  onCustomStatusesChanged?: () => void
}

export function SettingsDialog({
  open,
  onOpenChange,
  theme,
  onThemeChange,
  zoomLevel,
  onZoomChange,
  databasePath,
  workspaceId,
  vimNavigationEnabled,
  onVimNavigationChange,
  updateCheckEnabled,
  onUpdateCheckEnabledChange,
  updateCheckFrequency,
  onUpdateCheckFrequencyChange,
  updateAvailable,
  updateChecking,
  updateCheckError,
  onCheckForUpdates,
  onOpenUpdateDialog,
  initialTab,
  onCustomStatusesChanged,
}: SettingsDialogProps) {
  const [isTauri, setIsTauri] = useState(false)

  useEffect(() => {
    setIsTauri(isTauriRuntime())
  }, [])
  const [activeTab, setActiveTab] = useState<SettingsTab>("general")
  const [focusedThemeIndex, setFocusedThemeIndex] = useState(0)
  const themeCardRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(true)

  // Track whether we just did a manual check (to show result feedback)
  const [showCheckResult, setShowCheckResult] = useState(false)
  const checkResultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear result feedback when dialog closes
  useEffect(() => {
    if (!open) {
      setShowCheckResult(false)
      if (checkResultTimeoutRef.current) {
        clearTimeout(checkResultTimeoutRef.current)
        checkResultTimeoutRef.current = null
      }
    }
  }, [open])

  const handleCheckForUpdates = useCallback(async () => {
    setShowCheckResult(false)
    await onCheckForUpdates()
    setShowCheckResult(true)
    // Auto-dismiss the "up to date" message after 5 seconds
    if (checkResultTimeoutRef.current) clearTimeout(checkResultTimeoutRef.current)
    checkResultTimeoutRef.current = setTimeout(() => setShowCheckResult(false), 5000)
  }, [onCheckForUpdates])

  // Load analytics preference on mount
  useEffect(() => {
    setAnalyticsEnabledState(getAnalyticsEnabled())
  }, [])

  const handleAnalyticsToggle = useCallback(() => {
    const next = !analyticsEnabled
    if (next) {
      // Opt-in: re-enable capturing first so the event is recorded
      setAnalyticsEnabledState(next)
      setAnalyticsEnabled(next)
      posthog.opt_in_capturing()
      safeCapture("app_setting_changed", {
        setting: "analytics",
        old_value: !next,
        new_value: next,
      })
    } else {
      // Opt-out: fire event BEFORE disabling so the opt-out itself is recorded
      safeCapture("app_setting_changed", {
        setting: "analytics",
        old_value: !next,
        new_value: next,
      })
      setAnalyticsEnabledState(next)
      setAnalyticsEnabled(next)
      posthog.opt_out_capturing()
    }
  }, [analyticsEnabled])

  // Sync focused index to current theme when dialog opens
  useEffect(() => {
    if (open) {
      const idx = THEME_OPTIONS.findIndex((t) => t.id === theme)
      setFocusedThemeIndex(idx >= 0 ? idx : 0)
    }
  }, [open, theme])

  const handleThemeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const len = THEME_OPTIONS.length
      let nextIndex = focusedThemeIndex

      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault()
          nextIndex = (focusedThemeIndex + 1) % len
          break
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault()
          nextIndex = (focusedThemeIndex - 1 + len) % len
          break
        case "Enter":
        case " ":
          e.preventDefault()
          if (getAnalyticsEnabled()) {
            safeCapture("app_setting_changed", {
              setting: "theme",
              old_value: theme,
              new_value: THEME_OPTIONS[focusedThemeIndex].id,
            })
          }
          onThemeChange(THEME_OPTIONS[focusedThemeIndex].id)
          return
        default:
          return
      }

      setFocusedThemeIndex(nextIndex)
      themeCardRefs.current[nextIndex]?.focus()
    },
    [focusedThemeIndex, onThemeChange, theme],
  )

  const [appLogDir, setAppLogDir] = useState<string | null>(null)

  // Reset to requested tab (or General) each time the dialog opens
  useEffect(() => {
    if (open) {
      setActiveTab(initialTab ?? "general")
      rpc.system
        .getLogDirectory()
        .then(setAppLogDir)
        .catch(() => setAppLogDir(null))
    }
  }, [open, initialTab])

  const handleOpenLogDir = useCallback(async () => {
    if (!appLogDir) return
    const result = await rpc.system.openInFileManager(appLogDir)
    if (!result.success) {
      toast.error("Could not open folder", { description: result.error })
    }
  }, [appLogDir])

  const handleClearCache = useCallback(() => {
    clearCache()
    toast.success("Cache cleared", { description: "Reloading..." })
    setTimeout(() => window.location.reload(), 800)
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="fixed inset-0 top-0 left-0 translate-x-0 translate-y-0 w-full h-full max-w-none sm:max-w-none max-h-none flex flex-col p-0 gap-0 rounded-none border-0 font-settings"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Visually hidden title for accessibility */}
        <DialogTitle className="sr-only">Settings</DialogTitle>

        {/* Header with close button */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-xl font-semibold">Settings</h2>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <nav className="w-48 border-r py-3 px-2 shrink-0" aria-label="Settings navigation">
            <ul className="space-y-0.5" role="tablist">
              {tabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <li key={tab.id}>
                    <button
                      role="tab"
                      aria-selected={activeTab === tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={cn(
                        "flex items-center gap-2.5 w-full px-3 py-2 text-sm leading-relaxed rounded-md transition-colors text-left",
                        activeTab === tab.id
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {tab.label}
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-6" role="tabpanel">
            {activeTab === "general" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold mb-1">Theme</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Choose your preferred color scheme
                  </p>
                  <div
                    role="radiogroup"
                    aria-label="Theme selection"
                    className="grid grid-cols-3 gap-3 max-w-lg"
                    onKeyDown={handleThemeKeyDown}
                  >
                    {THEME_OPTIONS.map((opt, i) => {
                      const selected = theme === opt.id
                      return (
                        <button
                          key={opt.id}
                          ref={(el) => {
                            themeCardRefs.current[i] = el
                          }}
                          role="radio"
                          aria-checked={selected}
                          aria-label={`${opt.label} theme`}
                          tabIndex={focusedThemeIndex === i ? 0 : -1}
                          onClick={() => {
                            if (getAnalyticsEnabled()) {
                              safeCapture("app_setting_changed", {
                                setting: "theme",
                                old_value: theme,
                                new_value: opt.id,
                              })
                            }
                            onThemeChange(opt.id)
                          }}
                          className={cn(
                            "relative rounded-lg border-2 p-1 transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                            selected
                              ? "border-primary ring-1 ring-primary/30"
                              : "border-transparent hover:border-muted-foreground/30",
                          )}
                        >
                          {/* Mini UI preview */}
                          <div
                            className="rounded-md overflow-hidden aspect-[4/3]"
                            style={{ backgroundColor: opt.colors.bg }}
                          >
                            {/* Header bar */}
                            <div
                              className="flex items-center gap-1 px-2 py-1.5"
                              style={{ borderBottom: `1px solid ${opt.colors.secondary}` }}
                            >
                              <div className="flex gap-0.5">
                                <div
                                  className="w-1.5 h-1.5 rounded-full"
                                  style={{ backgroundColor: opt.colors.primary, opacity: 0.8 }}
                                />
                                <div
                                  className="w-1.5 h-1.5 rounded-full"
                                  style={{ backgroundColor: opt.colors.primary, opacity: 0.5 }}
                                />
                                <div
                                  className="w-1.5 h-1.5 rounded-full"
                                  style={{ backgroundColor: opt.colors.primary, opacity: 0.3 }}
                                />
                              </div>
                              <div
                                className="h-1.5 w-8 rounded-sm ml-1"
                                style={{ backgroundColor: opt.colors.muted, opacity: 0.4 }}
                              />
                            </div>
                            {/* Content rows */}
                            <div className="px-2 py-1.5 space-y-1">
                              <div className="flex items-center gap-1.5">
                                <div
                                  className="h-1.5 w-6 rounded-sm"
                                  style={{ backgroundColor: opt.colors.primary, opacity: 0.7 }}
                                />
                                <div
                                  className="h-1.5 flex-1 rounded-sm"
                                  style={{ backgroundColor: opt.colors.muted, opacity: 0.3 }}
                                />
                              </div>
                              <div className="flex items-center gap-1.5">
                                <div
                                  className="h-1.5 w-6 rounded-sm"
                                  style={{ backgroundColor: opt.colors.secondary }}
                                />
                                <div
                                  className="h-1.5 flex-1 rounded-sm"
                                  style={{ backgroundColor: opt.colors.muted, opacity: 0.2 }}
                                />
                              </div>
                              <div className="flex items-center gap-1.5">
                                <div
                                  className="h-1.5 w-6 rounded-sm"
                                  style={{ backgroundColor: opt.colors.secondary }}
                                />
                                <div
                                  className="h-1.5 w-3/4 rounded-sm"
                                  style={{ backgroundColor: opt.colors.muted, opacity: 0.2 }}
                                />
                              </div>
                            </div>
                          </div>
                          {/* Selected indicator */}
                          {selected && (
                            <div className="absolute top-2.5 right-2.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                              <Check className="w-2.5 h-2.5 text-primary-foreground" />
                            </div>
                          )}
                          {/* Theme label */}
                          <div
                            className={cn(
                              "text-xs text-center mt-2 pb-1 font-medium",
                              selected ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {opt.label}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Zoom (Tauri only) */}
                {isTauri && (
                  <div>
                    <h3 className="text-lg font-semibold mb-1">Zoom</h3>
                    <p className="text-sm text-muted-foreground mb-3">Adjust the interface scale</p>
                    <div className="flex items-center gap-3 max-w-lg">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => {
                          if (getAnalyticsEnabled()) {
                            safeCapture("app_setting_changed", {
                              setting: "zoom",
                              old_value: zoomLevel,
                              new_value: zoomLevel - 10,
                            })
                          }
                          onZoomChange(zoomLevel - 10)
                        }}
                        disabled={zoomLevel <= 50}
                        aria-label="Zoom out"
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <span className="text-sm font-medium tabular-nums w-12 text-center">
                        {zoomLevel}%
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => {
                          if (getAnalyticsEnabled()) {
                            safeCapture("app_setting_changed", {
                              setting: "zoom",
                              old_value: zoomLevel,
                              new_value: zoomLevel + 10,
                            })
                          }
                          onZoomChange(zoomLevel + 10)
                        }}
                        disabled={zoomLevel >= 200}
                        aria-label="Zoom in"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                      {zoomLevel !== 100 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground"
                          onClick={() => {
                            if (getAnalyticsEnabled()) {
                              safeCapture("app_setting_changed", {
                                setting: "zoom",
                                old_value: zoomLevel,
                                new_value: 100,
                              })
                            }
                            onZoomChange(100)
                          }}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Reset
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Use {"\u2318"}+ and {"\u2318"}- to zoom from anywhere
                    </p>
                  </div>
                )}

                {/* Analytics opt-out */}
                <div>
                  <h3 className="text-lg font-semibold mb-1">Privacy</h3>
                  <div className="flex items-center justify-between max-w-lg">
                    <div>
                      <p className="text-sm font-medium">Send anonymous usage data</p>
                      <p className="text-sm text-muted-foreground">
                        Help us fix bugs faster by sending anonymous crash reports and usage stats.
                        No personal data or file contents are ever collected.
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={analyticsEnabled}
                      onClick={handleAnalyticsToggle}
                      className={cn(
                        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        analyticsEnabled ? "bg-primary" : "bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow-lg ring-0 transition-transform",
                          analyticsEnabled ? "translate-x-5" : "translate-x-0",
                        )}
                      />
                    </button>
                  </div>
                </div>

                {/* Updates */}
                <div>
                  <h3 className="text-lg font-semibold mb-1">Updates</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Control how Beadbox checks for new versions
                  </p>
                  <div className="space-y-4 max-w-lg">
                    {/* Auto-check toggle */}
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">Automatically check for updates</p>
                        <p className="text-sm text-muted-foreground">
                          Periodically check GitHub for new releases
                        </p>
                      </div>
                      <button
                        role="switch"
                        aria-checked={updateCheckEnabled}
                        onClick={() => {
                          if (getAnalyticsEnabled()) {
                            safeCapture("app_setting_changed", {
                              setting: "update_check",
                              old_value: updateCheckEnabled,
                              new_value: !updateCheckEnabled,
                            })
                          }
                          onUpdateCheckEnabledChange(!updateCheckEnabled)
                        }}
                        className={cn(
                          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                          updateCheckEnabled ? "bg-primary" : "bg-muted",
                        )}
                      >
                        <span
                          className={cn(
                            "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow-lg ring-0 transition-transform",
                            updateCheckEnabled ? "translate-x-5" : "translate-x-0",
                          )}
                        />
                      </button>
                    </div>

                    {/* Check frequency */}
                    <div className={cn(!updateCheckEnabled && "opacity-50 pointer-events-none")}>
                      <label htmlFor="update-frequency" className="text-sm font-medium">
                        Check frequency
                      </label>
                      <select
                        id="update-frequency"
                        value={updateCheckFrequency}
                        onChange={(e) =>
                          onUpdateCheckFrequencyChange(
                            Number(e.target.value) as UpdateCheckFrequency,
                          )
                        }
                        disabled={!updateCheckEnabled}
                        className="mt-1 flex h-9 w-full max-w-[200px] rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {FREQUENCY_OPTIONS.map((opt) => (
                          <option
                            key={opt.value}
                            value={opt.value}
                            className="bg-background text-foreground"
                          >
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Check now button + result */}
                    <div className="space-y-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCheckForUpdates}
                        disabled={updateChecking}
                      >
                        <RefreshCw className={cn("h-4 w-4", updateChecking && "animate-spin")} />
                        {updateChecking ? "Checking..." : "Check for Updates"}
                      </Button>

                      {/* Result feedback */}
                      {showCheckResult &&
                        !updateChecking &&
                        (updateCheckError ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                            <span>
                              Couldn&apos;t check for updates. You may still be on the latest
                              version — this means the check itself failed, not that no update
                              exists.
                            </span>
                          </div>
                        ) : updateAvailable ? (
                          <div className="flex items-center gap-2 text-sm">
                            <ArrowUpCircle className="h-4 w-4 text-primary shrink-0" />
                            <span>
                              Version {updateAvailable.version} is available.{" "}
                              <button
                                onClick={() => {
                                  onOpenChange(false)
                                  onOpenUpdateDialog?.()
                                }}
                                className="inline-flex items-center gap-1 text-foreground hover:underline font-medium"
                              >
                                View details
                                <ExternalLink className="h-3 w-3" />
                              </button>
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                            <span>You&apos;re on the latest version (v{version})</span>
                          </div>
                        ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {activeTab === "workflow" && (
              <CustomStatusesManager
                databasePath={workspaceId ?? databasePath}
                onStatusesChanged={onCustomStatusesChanged}
              />
            )}
            {activeTab === "shortcuts" && (
              <div className="space-y-6">
                {/* Vim navigation toggle */}
                <div>
                  <h3 className="text-lg font-semibold mb-1">Vim-style Navigation</h3>
                  <div className="flex items-center justify-between max-w-lg">
                    <div>
                      <p className="text-sm font-medium">Enable vim keys</p>
                      <p className="text-sm text-muted-foreground">
                        Use j/k to move up and down, G to jump to bottom, gg to jump to top, and h/l
                        to collapse/expand.
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={vimNavigationEnabled}
                      onClick={() => {
                        if (getAnalyticsEnabled()) {
                          safeCapture("app_setting_changed", {
                            setting: "vim_mode",
                            old_value: vimNavigationEnabled,
                            new_value: !vimNavigationEnabled,
                          })
                        }
                        onVimNavigationChange(!vimNavigationEnabled)
                      }}
                      className={cn(
                        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        vimNavigationEnabled ? "bg-primary" : "bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow-lg ring-0 transition-transform",
                          vimNavigationEnabled ? "translate-x-5" : "translate-x-0",
                        )}
                      />
                    </button>
                  </div>
                </div>

                {/* Shortcut reference table */}
                <div>
                  <h3 className="text-lg font-semibold mb-3">Shortcut Reference</h3>
                  <div className="max-w-lg space-y-4">
                    {/* Always-active shortcuts */}
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">
                        Always Active
                      </h4>
                      <div className="rounded-md border">
                        <table className="w-full text-sm">
                          <tbody>
                            {[
                              { keys: ["/"], action: "Focus search bar" },
                              { keys: ["Enter"], action: "Open selected item" },
                              { keys: ["Escape"], action: "Close detail panel / deselect" },
                              { keys: ["\u2191", "\u2193"], action: "Navigate up / down" },
                              { keys: ["\u2190", "\u2192"], action: "Collapse / expand item" },
                              { keys: ["\u2318", "F"], action: "Toggle filter bar" },
                              { keys: ["\u2318", "1"], action: "Switch to Beads view" },
                              { keys: ["\u2318", "2"], action: "Switch to Activity view" },
                              { keys: ["\u2318", ","], action: "Open Settings" },
                              { keys: ["\u2318", "R"], action: "Refresh data" },
                            ].map((row, i) => (
                              <tr key={i} className={i > 0 ? "border-t" : ""}>
                                <td className="px-3 py-2 w-32">
                                  <span className="inline-flex gap-1">
                                    {row.keys.map((k, ki) => (
                                      <kbd
                                        key={ki}
                                        className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded bg-muted text-xs font-mono font-medium"
                                      >
                                        {k}
                                      </kbd>
                                    ))}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">{row.action}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Vim shortcuts */}
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">
                        Vim Navigation
                        {!vimNavigationEnabled && (
                          <span className="ml-2 text-xs font-normal normal-case text-muted-foreground/60">
                            (disabled)
                          </span>
                        )}
                      </h4>
                      <div
                        className={cn("rounded-md border", !vimNavigationEnabled && "opacity-50")}
                      >
                        <table className="w-full text-sm">
                          <tbody>
                            {[
                              { keys: ["j", "k"], action: "Move down / up" },
                              { keys: ["G"], action: "Jump to bottom" },
                              { keys: ["g", "g"], action: "Jump to top" },
                              { keys: ["h", "l"], action: "Collapse / expand item" },
                              { keys: ["j", "k"], action: "Next / prev comment (detail panel)" },
                              { keys: ["h"], action: "Back to tree (detail panel)" },
                              { keys: ["U"], action: "Mark all visible as read" },
                            ].map((row, i) => (
                              <tr key={i} className={i > 0 ? "border-t" : ""}>
                                <td className="px-3 py-2 w-32">
                                  <span className="inline-flex gap-1">
                                    {row.keys.map((k, ki) => (
                                      <kbd
                                        key={ki}
                                        className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded bg-muted text-xs font-mono font-medium"
                                      >
                                        {k}
                                      </kbd>
                                    ))}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">{row.action}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Zoom shortcuts */}
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">
                        Zoom
                        <span className="ml-2 text-xs font-normal normal-case text-muted-foreground/60">
                          (desktop app only)
                        </span>
                      </h4>
                      <div className="rounded-md border">
                        <table className="w-full text-sm">
                          <tbody>
                            {[
                              { keys: ["\u2318", "="], action: "Zoom in" },
                              { keys: ["\u2318", "-"], action: "Zoom out" },
                              { keys: ["\u2318", "0"], action: "Reset zoom" },
                            ].map((row, i) => (
                              <tr key={i} className={i > 0 ? "border-t" : ""}>
                                <td className="px-3 py-2 w-32">
                                  <span className="inline-flex gap-1">
                                    {row.keys.map((k, ki) => (
                                      <kbd
                                        key={ki}
                                        className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded bg-muted text-xs font-mono font-medium"
                                      >
                                        {k}
                                      </kbd>
                                    ))}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">{row.action}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Activity view shortcuts */}
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">
                        Activity View
                      </h4>
                      <div className="rounded-md border">
                        <table className="w-full text-sm">
                          <tbody>
                            {[
                              { keys: ["1", "-", "5"], action: "Filter by pipeline stage" },
                              { keys: ["a"], action: "Toggle agent focus mode" },
                              { keys: ["f"], action: "Toggle filter panel" },
                            ].map((row, i) => (
                              <tr key={i} className={i > 0 ? "border-t" : ""}>
                                <td className="px-3 py-2 w-32">
                                  <span className="inline-flex gap-1">
                                    {row.keys.map((k, ki) => (
                                      <kbd
                                        key={ki}
                                        className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded bg-muted text-xs font-mono font-medium"
                                      >
                                        {k}
                                      </kbd>
                                    ))}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">{row.action}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Dev console shortcuts */}
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">
                        Dev Console
                      </h4>
                      <div className="rounded-md border">
                        <table className="w-full text-sm">
                          <tbody>
                            {[
                              { keys: ["`"], action: "Toggle dev console" },
                              { keys: ["\u2318", "K"], action: "Clear active tab" },
                            ].map((row, i) => (
                              <tr key={i} className={i > 0 ? "border-t" : ""}>
                                <td className="px-3 py-2 w-32">
                                  <span className="inline-flex gap-1">
                                    {row.keys.map((k, ki) => (
                                      <kbd
                                        key={ki}
                                        className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded bg-muted text-xs font-mono font-medium"
                                      >
                                        {k}
                                      </kbd>
                                    ))}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">{row.action}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {activeTab === "help" && (
              <HelpTabContent
                databasePath={databasePath}
                appLogDir={appLogDir}
                handleOpenLogDir={handleOpenLogDir}
                handleClearCache={handleClearCache}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t text-xs text-muted-foreground shrink-0">
          <div className="flex items-center gap-1.5">
            <span>Enjoying Beadbox?</span>
            <button
              onClick={() => {
                const url = "https://github.com/beadbox/beadbox"
                if (isTauriRuntime()) {
                  window.location.href = url
                } else {
                  window.open(url, "_blank", "noopener,noreferrer")
                }
              }}
              className="inline-flex items-center gap-1 text-foreground hover:underline font-medium"
            >
              Star us on GitHub
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                // beadbox-l5i.2: this used to deep-link a markdown file that the
                // public repo does not carry, so it 404'd. Releases is the
                // public changelog.
                const url = "https://github.com/beadbox/beadbox/releases"
                if (isTauriRuntime()) {
                  window.location.href = url
                } else {
                  window.open(url, "_blank", "noopener,noreferrer")
                }
              }}
              className="hover:underline hover:text-foreground transition-colors"
            >
              Changelog
            </button>
            <span>
              v{version}
              {buildId ? ` (build ${buildId})` : ""}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Platform display helpers ──────────────────────────────────────────────

function platformLabel(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macOS"
    case "linux":
      return "Linux"
    case "win32":
      return "Windows"
    default:
      return platform
  }
}

// ─── Status indicator icon ─────────────────────────────────────────────────

function StatusIcon({ status }: { status: VersionCheck["status"] }) {
  switch (status) {
    case "ok":
      return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
    case "warning":
      return <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
    case "error":
      return <X className="h-4 w-4 text-red-400 shrink-0" />
    default:
      return <AlertTriangle className="h-4 w-4 text-muted-foreground shrink-0" />
  }
}

// ─── Diagnostics Panel ────────────────────────────────────────────────────

function DiagnosticsPanel({ databasePath }: { databasePath?: string }) {
  const [result, setResult] = useState<DiagnosticsResult | null>(null)
  const [running, setRunning] = useState(false)

  const handleRun = useCallback(async () => {
    setRunning(true)
    setResult(null)
    try {
      const res = await rpc.diagnostics.runDiagnostics(databasePath)
      setResult(res)
    } catch {
      setResult({
        ok: false,
        passed: 0,
        warnings: 0,
        errors: 0,
        checks: [],
        error: "Failed to run diagnostics.",
      })
    } finally {
      setRunning(false)
    }
  }, [databasePath])

  const handleCopyCommand = useCallback(async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      toast.success("Copied!", { description: "Fix command copied to clipboard" })
    } catch {
      toast.error("Failed to copy to clipboard")
    }
  }, [])

  const hasIssues = result && (result.warnings > 0 || result.errors > 0)
  const issueChecks = result?.checks.filter((c) => c.status !== "pass") ?? []

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRun}
          disabled={running || !databasePath}
          title={!databasePath ? "Select a workspace first" : undefined}
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Stethoscope className="h-4 w-4" />
          )}
          {running ? "Running..." : "Run diagnostics"}
        </Button>
      </div>

      {/* Error state */}
      {result?.error && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
          <CircleX className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
          <span className="text-red-300">{result.error}</span>
        </div>
      )}

      {/* Results summary */}
      {result && !result.error && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              Diagnostics: <span className="text-green-500">{result.passed} passed</span>
              {result.warnings > 0 && (
                <>
                  ,{" "}
                  <span className="text-amber-400">
                    {result.warnings} warning{result.warnings !== 1 ? "s" : ""}
                  </span>
                </>
              )}
              {result.errors > 0 && (
                <>
                  ,{" "}
                  <span className="text-red-400">
                    {result.errors} error{result.errors !== 1 ? "s" : ""}
                  </span>
                </>
              )}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRun}
              disabled={running}
              className="h-auto px-2 py-1 text-xs"
            >
              Run again
            </Button>
          </div>

          {/* Warning/error cards */}
          {hasIssues && (
            <div className="space-y-2">
              {issueChecks.map((check) => (
                <DiagnosticCheckCard
                  key={check.name}
                  check={check}
                  onCopyCommand={handleCopyCommand}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DiagnosticCheckCard({
  check,
  onCopyCommand,
}: {
  check: DiagnosticCheck
  onCopyCommand: (cmd: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isError = check.status === "fail"
  const borderColor = isError ? "border-red-500/30" : "border-amber-500/30"
  const iconColor = isError ? "text-red-400" : "text-amber-400"

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className={cn("rounded-md border", borderColor)}>
        <CollapsibleTrigger className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-accent/50 transition-colors">
          <div className="flex items-center gap-2">
            {isError ? (
              <CircleX className={cn("h-4 w-4 shrink-0", iconColor)} />
            ) : (
              <AlertTriangle className={cn("h-4 w-4 shrink-0", iconColor)} />
            )}
            <span className="font-medium">{check.name}</span>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 space-y-2 border-t pt-2">
            {check.explanation && (
              <p className="text-sm text-muted-foreground">{check.explanation}</p>
            )}
            {check.commands && check.commands.length > 0 && (
              <div className="space-y-1.5">
                {check.commands.map((cmd, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <code
                      className="flex-1 text-xs bg-muted px-2 py-1.5 rounded font-mono truncate"
                      title={cmd}
                    >
                      {cmd}
                    </code>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onCopyCommand(cmd)}
                      className="h-auto px-2 py-1 shrink-0"
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

// ─── Help Tab Content (extracted for useBdHealth hook) ─────────────────────

function HelpTabContent({
  databasePath,
  appLogDir,
  handleOpenLogDir,
  handleClearCache,
}: {
  databasePath?: string
  appLogDir: string | null
  handleOpenLogDir: () => void
  handleClearCache: () => void
}) {
  const [showCacheStats, setShowCacheStats] = useState(false)
  const [cacheStats, setCacheStats] = useState<{
    epicCached: boolean
    epicDbPath: string | null
    epicFingerprintParts: { headHash: string; maxUpdatedAt: string; commentFp: string } | null
    beadDetailCache: { size: number; entries: Array<{ id: string; commentCount: number }> }
  } | null>(null)
  const [loadingStats, setLoadingStats] = useState(false)

  const handleShowCacheStats = useCallback(async () => {
    setShowCacheStats(true)
    setLoadingStats(true)
    try {
      // P3.1: dynamic action import → rpc namespace call
      const stats = await rpc.epics.getCacheStats()
      setCacheStats(stats)
    } catch {
      setCacheStats(null)
    } finally {
      setLoadingStats(false)
    }
  }, [])
  const { bdVersion, bdPath, platform } = useBdHealth()

  const bdCheck = getVersionStatus("bd", bdVersion ?? null, platform)
  bdCheck.path = bdPath ?? null

  const beadboxCheck = getVersionStatus("beadbox", version, platform)

  const handleCopySystemInfo = useCallback(async () => {
    const lines: string[] = []
    lines.push(`Beadbox v${version}${buildId ? ` (build ${buildId})` : ""}`)
    lines.push(`beads ${bdVersion ? `v${bdVersion}` : "not found"}${bdPath ? ` (${bdPath})` : ""}`)
    lines.push(`Platform: ${platformLabel(platform)}`)

    try {
      await navigator.clipboard.writeText(lines.join("\n"))
      toast.success("Copied!", { description: "System info copied to clipboard" })
    } catch {
      toast.error("Failed to copy to clipboard")
    }
  }, [bdVersion, bdPath, platform])

  const rows: { label: string; check: VersionCheck }[] = [
    { label: "Beadbox", check: beadboxCheck },
    { label: "beads CLI", check: bdCheck },
  ]

  return (
    <div className="space-y-6">
      {/* System */}
      <section>
        <h3 className="text-lg font-semibold">System</h3>
        <p className="text-sm text-muted-foreground mt-1 mb-3">
          Installed tool versions and compatibility status.
        </p>
        <div className="rounded-md border max-w-lg">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.label} className={i > 0 ? "border-t" : ""}>
                  <td className="px-3 py-2.5 font-medium w-24">{row.label}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs">
                            {row.check.version ? `v${row.check.version}` : "Not found"}
                          </span>
                          {row.check.path && (
                            <span
                              className="text-xs text-muted-foreground truncate max-w-[200px]"
                              title={row.check.path}
                            >
                              {row.check.path}
                            </span>
                          )}
                        </div>
                        {row.check.message && (
                          <div className="text-xs mt-1 flex items-center gap-1.5">
                            <span
                              className={
                                row.check.status === "error" ? "text-red-400" : "text-amber-400"
                              }
                            >
                              {row.check.message}
                            </span>
                            {row.check.upgradeCommand && (
                              <span className="text-muted-foreground">
                                Run:{" "}
                                <code className="bg-muted px-1 py-0.5 rounded text-foreground">
                                  {row.check.upgradeCommand}
                                </code>
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <StatusIcon status={row.check.status} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button variant="outline" size="sm" onClick={handleCopySystemInfo} className="mt-3">
          <Copy className="h-4 w-4" />
          Copy system info
        </Button>
        <DiagnosticsPanel databasePath={databasePath} />
      </section>

      {/* Support */}
      <section>
        <h3 className="text-lg font-semibold">Support</h3>
        <p className="text-sm text-muted-foreground mt-1">
          If you need help with Beadbox or want to report a bug, please reach out to us on GitHub.
        </p>
        <button
          onClick={() => {
            const url = "https://github.com/beadbox/beadbox/issues"
            if (isTauriRuntime()) {
              window.location.href = url
            } else {
              window.open(url, "_blank", "noopener,noreferrer")
            }
          }}
          className="inline-flex items-center gap-1.5 text-sm text-foreground hover:underline font-medium mt-2"
        >
          Open GitHub Issues
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </section>

      {/* Logs */}
      <section>
        <h3 className="text-lg font-semibold">Logs</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Startup diagnostics and server logs for troubleshooting.
        </p>
        {appLogDir ? (
          <button
            onClick={handleOpenLogDir}
            className="inline-flex items-center gap-1.5 text-sm text-foreground hover:underline font-medium mt-2 text-left break-all"
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            {appLogDir}
          </button>
        ) : (
          <p className="text-sm text-muted-foreground mt-2 italic">
            Logs are output to the terminal in dev mode.
          </p>
        )}
      </section>

      {/* Cache */}
      <section>
        <h3 className="text-lg font-semibold">Cache</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Beadbox uses local storage to cache preferences and UI state. If you&apos;re experiencing
          issues, clearing the cache might help.
        </p>
        <Button variant="outline" size="sm" onClick={handleClearCache} className="mt-3">
          <Trash2 className="h-4 w-4" />
          Clear Cache
        </Button>
      </section>

      {/* Developer */}
      <section>
        <h3 className="text-lg font-semibold">Developer</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Inspect internal server-side cache state.
        </p>
        <Button variant="outline" size="sm" onClick={handleShowCacheStats} className="mt-3">
          <Stethoscope className="h-4 w-4" />
          Cache Inspector
        </Button>
      </section>

      {/* Cache stats modal */}
      <Dialog open={showCacheStats} onOpenChange={setShowCacheStats}>
        <DialogContent className="max-w-lg">
          <DialogTitle>Cache Inspector</DialogTitle>
          {loadingStats ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading cache stats...
            </div>
          ) : cacheStats ? (
            <div className="space-y-4 text-sm">
              <div>
                <h4 className="font-medium mb-1">Epic Tree Cache</h4>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
                  <span>Status:</span>
                  <span className={cacheStats.epicCached ? "text-green-400" : "text-amber-400"}>
                    {cacheStats.epicCached ? "Cached" : "Empty"}
                  </span>
                  {cacheStats.epicDbPath && (
                    <>
                      <span>DB Path:</span>
                      <span className="truncate font-mono text-xs">{cacheStats.epicDbPath}</span>
                    </>
                  )}
                  {cacheStats.epicFingerprintParts && (
                    <>
                      <span>HEAD:</span>
                      <span className="font-mono text-xs">
                        {cacheStats.epicFingerprintParts.headHash.slice(0, 12)}
                      </span>
                      <span>Updated:</span>
                      <span className="font-mono text-xs">
                        {cacheStats.epicFingerprintParts.maxUpdatedAt}
                      </span>
                      <span>Comments:</span>
                      <span className="font-mono text-xs">
                        {cacheStats.epicFingerprintParts.commentFp}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div>
                <h4 className="font-medium mb-1">Bead Detail Cache</h4>
                <p className="text-muted-foreground mb-2">
                  {cacheStats.beadDetailCache.size} bead(s) cached
                </p>
                {cacheStats.beadDetailCache.entries.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border border-border rounded p-2 space-y-1">
                    {cacheStats.beadDetailCache.entries.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex justify-between font-mono text-xs text-muted-foreground"
                      >
                        <span>{entry.id}</span>
                        <span>{entry.commentCount} comments</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4">Failed to load cache stats.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
