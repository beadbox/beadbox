import {
  ArrowRight,
  Check,
  Clock,
  Download,
  ExternalLink,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react"
import { useCallback, useEffect } from "react"
import { type DownloadStatus, useUpdateDownloader } from "../hooks/use-update-downloader"
import { getAnalyticsEnabled } from "../lib/local-storage"
import { safeCapture } from "../lib/posthog-safe"
import { isTauriRuntime } from "../lib/rpc"
import type { UpdateInfo } from "../lib/update-checker"
import { SimpleMarkdown } from "./simple-markdown"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog"
import { Progress } from "./ui/progress"

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  } catch {
    return iso
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / 1024 ** i
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

interface UpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  updateInfo: UpdateInfo
  onDismiss: () => void
  currentVersion: string
}

export function UpdateDialog({
  open,
  onOpenChange,
  updateInfo,
  onDismiss,
  currentVersion,
}: UpdateDialogProps) {
  const { status, progress, error, platform, startDownload, cancelDownload, reset } =
    useUpdateDownloader()

  const isTauri = isTauriRuntime()

  // Reset downloader state when dialog closes
  useEffect(() => {
    if (!open) {
      // Only reset if not in a "completed" state (user might close and reopen)
      if (status === "downloading" || status === "error") {
        reset()
      }
    }
  }, [open, status, reset])

  const handleViewOnGitHub = useCallback(() => {
    const url = updateInfo.releaseUrl
    if (isTauriRuntime()) {
      window.location.href = url
    } else {
      window.open(url, "_blank", "noopener,noreferrer")
    }
  }, [updateInfo.releaseUrl])

  const handleLater = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const handleDismissForVersion = useCallback(() => {
    onDismiss()
    onOpenChange(false)
  }, [onDismiss, onOpenChange])

  const handleDownload = useCallback(() => {
    if (getAnalyticsEnabled()) {
      safeCapture("app_update_downloaded", {
        available_version: updateInfo.version,
        platform: navigator.platform,
      })
    }
    // A-3': the Rust host (updater.rs) owns detection, auth, download, and
    // native .sig verification + install. The download re-resolves the update
    // server-side, so no JS Update object is threaded through.
    startDownload()
  }, [startDownload, updateInfo.version])

  // After downloadAndInstall completes, tauri-plugin-updater has already
  // installed the new binary in-place (or staged the installer on Windows).
  // Relaunch picks up the new version. Note: prior implementation called
  // exit(0) and required the user to manually relaunch; now relaunch is
  // automatic.
  const handleQuit = useCallback(async () => {
    if (!isTauri) return
    const { relaunch } = await import("@tauri-apps/plugin-process")
    await relaunch()
  }, [isTauri])

  // Auto-relaunch after install completes in Tauri.
  useEffect(() => {
    if (status === "installed" && isTauri) {
      const timer = setTimeout(() => {
        handleQuit()
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [status, isTauri, handleQuit])

  const displayContent = updateInfo.changelogContent ?? updateInfo.body
  const hasReleaseNotes = displayContent.trim().length > 0
  const isActive = status === "downloading" || status === "installing"
  const progressPercent =
    progress.total > 0 ? Math.round((progress.downloaded / progress.total) * 100) : 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Prevent closing while downloading/installing
        if (isActive && !next) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogTitle className="sr-only">Update Available</DialogTitle>

        {/* Header: version comparison */}
        <div className="px-6 pt-5 pb-4 border-b shrink-0">
          <h2 className="text-lg font-semibold mb-3">
            {status === "installed" ? "Update Ready" : "Update Available"}
          </h2>
          <div className="flex items-center gap-3 text-sm">
            <div className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-md bg-muted/50">
              <span className="text-xs text-muted-foreground">Current</span>
              <span className="font-mono font-medium">v{currentVersion}</span>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-md bg-primary/10 border border-primary/20">
              <span className="text-xs text-primary">Latest</span>
              <span className="font-mono font-medium text-primary">v{updateInfo.version}</span>
            </div>
            {updateInfo.publishedAt && (
              <span className="text-xs text-muted-foreground ml-auto">
                Released {formatDate(updateInfo.publishedAt)}
              </span>
            )}
          </div>
        </div>

        {/* Body: release notes OR install success content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
          {status === "installed" ? (
            <InstalledContent platform={platform} />
          ) : (
            <>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                What&apos;s New
              </h3>
              {hasReleaseNotes ? (
                <SimpleMarkdown content={displayContent} />
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  No release notes for this version.
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer: action buttons (varies by state) */}
        <div className="px-6 py-4 border-t shrink-0">
          <DialogFooter
            status={status}
            progress={progress}
            progressPercent={progressPercent}
            error={error}
            platform={platform}
            isTauri={isTauri}
            onLater={handleLater}
            onDismiss={handleDismissForVersion}
            onViewOnGitHub={handleViewOnGitHub}
            onDownload={handleDownload}
            onCancel={cancelDownload}
            onRetry={handleDownload}
            onQuit={handleQuit}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Content shown after successful install */
function InstalledContent({ platform }: { platform: string | null }) {
  if (platform === "darwin") {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
          <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-green-400">Download complete</p>
            <p className="text-sm text-muted-foreground mt-1">
              The disk image has been opened. Drag <strong>Beadbox</strong> to your Applications
              folder to update.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (platform === "linux") {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
          <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-green-400">Download complete</p>
            <p className="text-sm text-muted-foreground mt-1">
              The AppImage has been downloaded and made executable. Replace your current AppImage
              with the new one to update.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (platform === "win32") {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
          <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-green-400">Installer launched</p>
            <p className="text-sm text-muted-foreground mt-1">
              Follow the installation wizard to complete the update.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Fallback
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
      <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
      <p className="text-sm font-medium text-green-400">Update downloaded successfully.</p>
    </div>
  )
}

/** Footer actions that change based on download/install state */
function DialogFooter({
  status,
  progress,
  progressPercent,
  error,
  platform,
  isTauri,
  onLater,
  onDismiss,
  onViewOnGitHub,
  onDownload,
  onCancel,
  onRetry,
  onQuit: _onQuit,
}: {
  status: DownloadStatus
  progress: { downloaded: number; total: number }
  progressPercent: number
  error: string | null
  platform: string | null
  isTauri: boolean
  onLater: () => void
  onDismiss: () => void
  onViewOnGitHub: () => void
  onDownload: () => void
  onCancel: () => void
  onRetry: () => void
  onQuit: () => void
}) {
  if (status === "downloading") {
    return (
      <div className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Downloading update...</span>
            <span>
              {progress.total > 0
                ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)} (${progressPercent}%)`
                : formatBytes(progress.downloaded)}
            </span>
          </div>
          <Progress value={progress.total > 0 ? progressPercent : undefined} />
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X className="h-4 w-4" />
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  if (status === "installing") {
    return (
      <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Opening installer...</span>
      </div>
    )
  }

  if (status === "installed") {
    return (
      <div className="space-y-3">
        {isTauri ? (
          <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Restarting...</span>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onLater}>
              Close
            </Button>
          </div>
        )}
        {platform === "darwin" && (
          <p className="text-xs text-muted-foreground">
            You can also update via{" "}
            <code className="px-1 py-0.5 rounded bg-muted text-xs font-mono">
              brew upgrade --cask beadbox
            </code>{" "}
            if installed with Homebrew.
          </p>
        )}
      </div>
    )
  }

  if (status === "error") {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 p-2.5 rounded-md bg-destructive/10 border border-destructive/20">
          <X className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{error || "An unexpected error occurred."}</p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={onLater}>
            Later
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onViewOnGitHub}>
              View on GitHub
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" onClick={onRetry}>
              <RotateCcw className="h-4 w-4" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // idle state
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onLater}>
            <Clock className="h-4 w-4" />
            Later
          </Button>
          <button
            onClick={onDismiss}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Skip this version
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onViewOnGitHub}>
            View on GitHub
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" onClick={onDownload}>
            <Download className="h-4 w-4" />
            {isTauri ? "Download & Quit" : "Download & Install"}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        You can also update via{" "}
        <code className="px-1 py-0.5 rounded bg-muted text-xs font-mono">
          brew upgrade --cask beadbox
        </code>{" "}
        if installed with Homebrew.
      </p>
    </div>
  )
}
