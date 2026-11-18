"use client"

import { AlertTriangle, RefreshCw } from "lucide-react"
import { WorkspaceErrorScreen } from "@/components/workspace-error-screen"
import type { BdLoadError } from "@/lib/bd-error"

// Full-page error state shown when initial load fails (no existing data)
export function LoadErrorEmpty({
  error,
  onRetry,
  isRetrying,
  databasePath,
  autoRetryCountdown,
}: {
  error: BdLoadError
  onRetry: () => void
  isRetrying: boolean
  databasePath: string
  autoRetryCountdown?: number | null
}) {
  // Classified errors with known category get the full recovery screen (fatal, recoverable, or transient)
  if (error.category !== "unknown") {
    return (
      <WorkspaceErrorScreen
        error={error}
        onRetry={onRetry}
        isRetrying={isRetrying}
        databasePath={databasePath}
        autoRetryCountdown={autoRetryCountdown}
      />
    )
  }

  // Unknown errors: existing generic UI
  const isTimeout = error.message.includes("timeout")
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-4">
      <AlertTriangle className="h-8 w-8 text-warning-text" />
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-foreground">Unable to load workspace</p>
        <p className="text-xs">
          {isTimeout
            ? "The request timed out. The workspace may be slow to respond."
            : "Could not connect to the workspace."}
        </p>
        {!isTimeout && error.message && (
          <details className="mt-2 text-left max-w-md">
            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
              Details
            </summary>
            <pre className="mt-1 text-xs text-muted-foreground bg-muted/50 rounded p-2 whitespace-pre-wrap break-words">
              {error.message}
            </pre>
          </details>
        )}
      </div>
      <button
        onClick={onRetry}
        disabled={isRetrying}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
      >
        <RefreshCw className={`h-4 w-4 ${isRetrying ? "animate-spin" : ""}`} />
        Retry
      </button>
    </div>
  )
}
