import { X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ConsoleTab } from "../hooks/use-dev-console"
import type { BdCommandEvent, WsLifecycleEvent } from "../lib/console-types"
import { safeCapture } from "../lib/posthog-safe"
import { getAnalyticsEnabled } from "../lib/local-storage"
import { DevConsoleCommands } from "./dev-console-commands"

interface DevConsoleProps {
  open: boolean
  activeTab: ConsoleTab
  filter: string
  height: number
  filteredCommands: BdCommandEvent[]
  filteredEvents: WsLifecycleEvent[]
  showHeartbeats: boolean
  dbPath?: string
  onToggle: () => void
  onClose: () => void
  onSetActiveTab: (tab: ConsoleTab) => void
  onSetFilter: (filter: string) => void
  onSetHeight: (height: number) => void
  onClearCommands: () => void
  onClearEvents: () => void
  onToggleHeartbeats: () => void
  onExecuteCommand: (args: string[]) => Promise<void>
}

export function DevConsole({
  open,
  activeTab,
  filter,
  height,
  filteredCommands,
  filteredEvents,
  showHeartbeats,
  dbPath,
  onToggle,
  onClose,
  onSetActiveTab,
  onSetFilter,
  onSetHeight,
  onClearCommands,
  onClearEvents,
  onToggleHeartbeats,
  onExecuteCommand,
}: DevConsoleProps) {
  const resizingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)
  const [_filterFocused, setFilterFocused] = useState(false)

  // Keyboard handler
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const isInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable

      // ~ (Backquote) toggle
      if (e.code === "Backquote" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Don't toggle when typing in any input (including the console's own input)
        if (isInput) return
        e.preventDefault()
        onToggle()
        return
      }

      // Escape: close
      if (e.key === "Escape" && open) {
        e.preventDefault()
        onClose()
        return
      }

      // Cmd+K / Ctrl+K: clear active tab
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && open) {
        e.preventDefault()
        if (activeTab === "commands") onClearCommands()
        else onClearEvents()
        return
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, activeTab, onToggle, onClose, onClearCommands, onClearEvents])

  // Resize handle
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      resizingRef.current = true
      startYRef.current = e.clientY
      startHeightRef.current = height
      document.body.style.cursor = "ns-resize"
      document.body.style.userSelect = "none"
    },
    [height],
  )

  useEffect(() => {
    function handlePointerMove(e: PointerEvent) {
      if (!resizingRef.current) return
      const dy = startYRef.current - e.clientY
      onSetHeight(startHeightRef.current + dy)
    }

    function handlePointerUp() {
      if (!resizingRef.current) return
      resizingRef.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }
  }, [onSetHeight])

  const trackedExecuteCommand = useCallback(
    async (args: string[]) => {
      let success = true
      try {
        await onExecuteCommand(args)
      } catch (err) {
        success = false
        throw err
      } finally {
        if (getAnalyticsEnabled()) {
          safeCapture("app_dev_console_command", {
            command_type: args[0] || "unknown",
            success,
          })
        }
      }
    },
    [onExecuteCommand],
  )

  if (!open) return null

  const clearFn = activeTab === "commands" ? onClearCommands : onClearEvents

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 flex flex-col bg-background border-t border-border"
      style={{ height }}
      data-testid="dev-console"
    >
      {/* Resize handle */}
      <div
        className="h-1 cursor-ns-resize hover:bg-primary/30 active:bg-primary/50 shrink-0"
        onPointerDown={handlePointerDown}
        data-testid="resize-handle"
      />

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
        <button
          onClick={() => onSetActiveTab("commands")}
          className={`px-2 py-0.5 text-xs rounded transition-colors ${
            activeTab === "commands"
              ? "bg-muted text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-commands"
        >
          Commands
        </button>
        <button
          onClick={() => onSetActiveTab("events")}
          className={`px-2 py-0.5 text-xs rounded transition-colors ${
            activeTab === "events"
              ? "bg-muted text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-events"
        >
          Events
        </button>

        {activeTab === "events" && (
          <button
            onClick={onToggleHeartbeats}
            className="px-2 py-0.5 text-xs rounded text-muted-foreground hover:text-foreground transition-colors"
            data-testid="heartbeat-toggle"
          >
            {showHeartbeats ? "Hide heartbeats" : "Show heartbeats"}
          </button>
        )}

        <div className="flex-1" />

        <input
          value={filter}
          onChange={(e) => onSetFilter(e.target.value)}
          onFocus={() => setFilterFocused(true)}
          onBlur={() => setFilterFocused(false)}
          placeholder="Filter..."
          className="w-40 px-2 py-0.5 text-xs bg-muted rounded text-foreground outline-none placeholder:text-muted-foreground/50"
          data-testid="filter-input"
        />

        <button
          onClick={clearFn}
          className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="clear-button"
        >
          Clear
        </button>

        <button
          onClick={onClose}
          className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
          data-testid="close-button"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {activeTab === "commands" ? (
          <DevConsoleCommands
            commands={filteredCommands}
            dbPath={dbPath}
            onExecute={trackedExecuteCommand}
          />
        ) : (
          <EventsPlaceholder events={filteredEvents} />
        )}
      </div>
    </div>
  )
}

// Minimal events view (bead 4 will build the full version)
function EventsPlaceholder({ events }: { events: WsLifecycleEvent[] }) {
  return (
    <div className="h-full overflow-y-auto px-3 py-1" data-testid="events-tab">
      {events.length === 0 && (
        <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
          No events yet.
        </div>
      )}
      {events.map((evt) => (
        <div key={evt.id} className="flex items-baseline gap-2 py-0.5 text-xs font-mono">
          <span className="text-muted-foreground shrink-0">
            {new Date(evt.timestamp).toLocaleTimeString("en-US", {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span className={eventColor(evt.event)}>{evt.event}</span>
          {evt.detail && <span className="text-muted-foreground">{evt.detail}</span>}
        </div>
      ))}
    </div>
  )
}

function eventColor(event: WsLifecycleEvent["event"]): string {
  switch (event) {
    case "connected":
    case "recovered":
      return "text-success-text"
    case "disconnected":
    case "polling_error":
      return "text-destructive"
    case "reconnecting":
      return "text-warning-text"
    case "heartbeat":
      return "text-muted-foreground/50"
    default:
      return "text-foreground"
  }
}
