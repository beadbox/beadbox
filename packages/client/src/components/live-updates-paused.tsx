// beadbox-01f.2: the visible side of the live-updates watchdog in
// lib/subscribe.ts. Non-modal, shown only while the displayed workspace's
// change stream is known to be stalled; clears itself on the next heartbeat
// or real change. Refresh reloads the view without depending on the stream.

import { RefreshCw, WifiOff } from "lucide-react"
import { requestManualRefresh, useLiveUpdatesPaused } from "@/lib/subscribe"
import { cn } from "@/lib/utils"

export function LiveUpdatesPausedBanner() {
  const paused = useLiveUpdatesPaused()
  if (!paused) return null

  return (
    <div role="status" className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2">
      <div className="flex items-center justify-between max-w-screen-xl mx-auto gap-3">
        <div className="flex items-center gap-2 text-amber-400 text-sm min-w-0">
          <WifiOff className="h-4 w-4 shrink-0" />
          <span className="font-medium">Live updates paused.</span>
          <span className="text-amber-400/80 truncate">
            Changes made elsewhere won't appear until you refresh.
          </span>
        </div>
        <button
          type="button"
          onClick={requestManualRefresh}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 shrink-0 text-sm font-medium",
            "text-amber-300 hover:text-amber-200 hover:bg-amber-500/20",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50",
            "transition-colors",
          )}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>
    </div>
  )
}
