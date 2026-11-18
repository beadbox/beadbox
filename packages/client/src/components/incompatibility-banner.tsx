"use client"

import { AlertTriangle, X } from "lucide-react"
import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { MIN_BD_VERSION, type VersionCheck } from "@/lib/version-requirements"

const DISMISS_KEY = "incompatibility-banner-dismissed"

interface IncompatibilityBannerProps {
  bdCheck: VersionCheck
  onOpenSettings: () => void
}

export function IncompatibilityBanner({ bdCheck, onOpenSettings }: IncompatibilityBannerProps) {
  const [dismissed, setDismissed] = useState(false)

  // Check sessionStorage on mount for prior dismissal
  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "true") {
        setDismissed(true)
      }
    } catch {
      // sessionStorage unavailable
    }
  }, [])

  const bdIncompat = bdCheck.status === "error" && bdCheck.version !== null

  // bb-cu2n: only bd version matters now (bd v1.0.0+ embeds Dolt).
  // Don't render if bd is compatible, missing entirely (StartupGate handles that), or dismissed.
  if (!bdIncompat || dismissed) {
    return null
  }

  const handleDismiss = () => {
    setDismissed(true)
    try {
      sessionStorage.setItem(DISMISS_KEY, "true")
    } catch {
      // sessionStorage unavailable
    }
  }

  const message = `Your beads CLI (${bdCheck.version}) is below the minimum required by Beadbox (v${MIN_BD_VERSION}). Some features may not work.`

  return (
    <div className="bg-warning/15 border-b border-warning/30 px-4 py-3">
      <div className="flex items-center justify-between max-w-screen-xl mx-auto gap-3">
        <div className="flex items-start gap-2 text-warning-text flex-1 min-w-0">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="text-sm">
            <span className="font-medium">{message}</span>
            <button
              onClick={onOpenSettings}
              className={cn(
                "ml-2 text-warning-text/80 hover:text-warning-text underline underline-offset-2 font-medium",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/50 rounded-sm",
              )}
            >
              How to update
            </button>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className={cn(
            "inline-flex items-center justify-center rounded-md min-h-[44px] min-w-[44px] shrink-0",
            "text-warning-text/70 hover:text-warning-text hover:bg-warning/20",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/50",
            "transition-colors",
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Dismiss</span>
        </button>
      </div>
    </div>
  )
}
