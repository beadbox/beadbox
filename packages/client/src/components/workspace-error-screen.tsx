// P3.1 port of components/workspace-error-screen.tsx.
// Source-divergence:
//   - next/navigation useRouter → @tanstack/react-router useRouter; .push() → .navigate({to})
//   - actions/recovery.runRecoveryCommand → rpc.recovery.runRecoveryCommand

import { useRouter } from "@tanstack/react-router"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { BdLoadError } from "../lib/bd-error"
import { safeCapture } from "../lib/posthog-safe"
import { getAnalyticsEnabled } from "../lib/local-storage"
import { rpc } from "../lib/rpc"
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

const CATEGORY_TITLES: Record<string, string> = {
  "out-of-sync": "Workspace out of sync",
  "database-not-found": "Workspace database not found",
  "project-identity-mismatch": "Workspace needs to reconnect",
  "permission-denied": "Permission denied",
  "schema-missing": "Workspace not initialized",
  "server-unreachable": "Dolt server unreachable",
  timeout: "Connection timed out",
  unknown: "Unable to load workspace",
}

interface WorkspaceErrorScreenProps {
  error: BdLoadError
  onRetry: () => void
  isRetrying: boolean
  databasePath: string
  autoRetryCountdown?: number | null
}

export function WorkspaceErrorScreen({
  error,
  onRetry,
  isRetrying,
  databasePath,
  autoRetryCountdown,
}: WorkspaceErrorScreenProps) {
  const router = useRouter()
  const [copied, setCopied] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [isFixing, setIsFixing] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  const title = CATEGORY_TITLES[error.category] ?? "Unable to load workspace"

  useEffect(() => {
    if (!getAnalyticsEnabled()) return
    safeCapture("app_error_shown", {
      error_category: error.category,
      component: "workspace-error-screen",
      workspace_count: 0,
      has_retry: true,
    })
    // Only fire once per error category change, not on every re-render
  }, [error.category])

  const handleCopy = useCallback(async () => {
    if (!error.fixCommand) return
    try {
      await navigator.clipboard.writeText(error.fixCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback for environments without clipboard API
      const textarea = document.createElement("textarea")
      textarea.value = error.fixCommand
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand("copy")
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [error.fixCommand])

  const handleFix = useCallback(async () => {
    if (!error.fixCommand) return
    setIsFixing(true)
    setFixError(null)
    setConfirmOpen(false)

    const result = await rpc.recovery.runRecoveryCommand(error.fixCommand, databasePath)
    setIsFixing(false)

    if (result.success) {
      onRetry()
    } else {
      setFixError(result.error ?? "Command failed")
    }
  }, [error.fixCommand, databasePath, onRetry])

  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-4">
      <AlertTriangle className="h-8 w-8 text-amber-400" />

      <div className="text-center space-y-2 max-w-md">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {error.fixDescription && <p className="text-xs">{error.fixDescription}</p>}
      </div>

      {/* Fix command code block */}
      {error.fixCommand && (
        <div className="flex items-center gap-2 bg-muted/50 rounded-md px-3 py-2 font-mono text-xs text-muted-foreground">
          <code>{error.fixCommand}</code>
          <button
            onClick={handleCopy}
            className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted transition-colors shrink-0"
            title="Copy command"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-primary" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      )}

      {/* Auto-retry countdown for transient errors */}
      {autoRetryCountdown != null && autoRetryCountdown > 0 && (
        <p className="text-xs text-muted-foreground">
          <Loader2 className="inline h-3 w-3 animate-spin mr-1 align-text-bottom" />
          Retrying automatically... ({autoRetryCountdown}s)
        </p>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        {error.fixCommand && (
          <button
            onClick={() => setConfirmOpen(true)}
            disabled={isFixing}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 transition-colors disabled:opacity-50"
          >
            {isFixing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Fixing...
              </>
            ) : (
              "Fix this"
            )}
          </button>
        )}
        <button
          onClick={onRetry}
          disabled={isRetrying || isFixing}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isRetrying ? "animate-spin" : ""}`} />
          Retry
        </button>
        <button
          onClick={() => {
            if (getAnalyticsEnabled()) {
              safeCapture("app_navigation_used", {
                destination: "workspaces",
                source: "error-screen",
              })
            }
            router.navigate({ to: "/workspaces" as never })
          }}
          className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          Switch workspace
        </button>
      </div>

      {/* Fix error display */}
      {fixError && (
        <div className="max-w-md w-full">
          <pre className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md p-2 whitespace-pre-wrap break-words">
            {fixError}
          </pre>
        </div>
      )}

      {/* Collapsible error details */}
      {error.stderr && (
        <div className="max-w-md w-full">
          <button
            onClick={() => setDetailsOpen(!detailsOpen)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          >
            {detailsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Error details
          </button>
          {detailsOpen && (
            <pre className="mt-1 text-xs text-muted-foreground bg-muted/50 rounded p-2 whitespace-pre-wrap break-words">
              {error.stderr}
            </pre>
          )}
        </div>
      )}

      {/* Confirmation dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run recovery command?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This will run the following command on your workspace:</p>
                <pre className="text-xs font-mono bg-muted/50 rounded p-2">{error.fixCommand}</pre>
                <p className="text-xs text-muted-foreground break-all">Path: {databasePath}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleFix}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
