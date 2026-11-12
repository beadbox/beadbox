import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { BdCommandEvent, WsLifecycleEvent } from "../lib/console-types"
import { getAnalyticsEnabled } from "../lib/local-storage"
import { safeCapture } from "../lib/posthog-safe"

const MAX_ENTRIES = 500
const LS_HEIGHT_KEY = "bb-console-height"
const DEFAULT_HEIGHT = 200

function readStoredHeight(): number {
  if (typeof window === "undefined") return DEFAULT_HEIGHT
  const raw = localStorage.getItem(LS_HEIGHT_KEY)
  if (!raw) return DEFAULT_HEIGHT
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 100 ? n : DEFAULT_HEIGHT
}

export type ConsoleTab = "commands" | "events"

interface UseDevConsoleOptions {
  dbPath?: string
}

export function useDevConsole({ dbPath }: UseDevConsoleOptions) {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<ConsoleTab>("commands")
  const [filter, setFilter] = useState("")
  const [height, setHeightState] = useState(DEFAULT_HEIGHT)
  const [commands, setCommands] = useState<BdCommandEvent[]>([])
  const [events, setEvents] = useState<WsLifecycleEvent[]>([])
  const [showHeartbeats, setShowHeartbeats] = useState(false)

  // Capture diagnostics without waking the board while the console is closed.
  const commandBuffer = useRef<BdCommandEvent[]>([])
  const eventBuffer = useRef<WsLifecycleEvent[]>([])
  const openRef = useRef(open)
  openRef.current = open
  const prevDbPathRef = useRef(dbPath)

  useEffect(() => {
    if (open) {
      setCommands(commandBuffer.current)
      setEvents(eventBuffer.current)
    }
  }, [open])

  // Read height from localStorage on mount
  useEffect(() => {
    setHeightState(readStoredHeight())
  }, [])

  // Clear buffers on workspace switch
  useEffect(() => {
    if (prevDbPathRef.current !== dbPath) {
      prevDbPathRef.current = dbPath
      commandBuffer.current = []
      eventBuffer.current = []
      setCommands([])
      setEvents([])
    }
  }, [dbPath])

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      if (next && getAnalyticsEnabled()) {
        safeCapture("app_dev_console_opened", { method: "keyboard" })
      }
      return next
    })
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const addCommand = useCallback((event: BdCommandEvent) => {
    commandBuffer.current = [...commandBuffer.current.slice(-(MAX_ENTRIES - 1)), event]
    if (openRef.current) setCommands(commandBuffer.current)
  }, [])

  const addEvent = useCallback((event: WsLifecycleEvent) => {
    eventBuffer.current = [...eventBuffer.current.slice(-(MAX_ENTRIES - 1)), event]
    if (openRef.current) setEvents(eventBuffer.current)
  }, [])

  const clearCommands = useCallback(() => {
    commandBuffer.current = []
    setCommands([])
  }, [])
  const clearEvents = useCallback(() => {
    eventBuffer.current = []
    setEvents([])
  }, [])

  const setHeight = useCallback((h: number) => {
    const clamped = Math.max(100, Math.min(h, window.innerHeight * 0.6))
    setHeightState(clamped)
    localStorage.setItem(LS_HEIGHT_KEY, String(clamped))
  }, [])

  const toggleHeartbeats = useCallback(() => {
    setShowHeartbeats((prev) => !prev)
  }, [])

  const filteredCommands = useMemo(() => {
    if (!filter) return commands
    const lc = filter.toLowerCase()
    return commands.filter((c) => {
      const text = `${c.command} ${c.args.join(" ")} ${c.stderr ?? ""} ${c.resultSummary ?? ""}`
      return text.toLowerCase().includes(lc)
    })
  }, [commands, filter])

  const filteredEvents = useMemo(() => {
    let filtered = events
    if (!showHeartbeats) {
      filtered = filtered.filter((e) => e.event !== "heartbeat")
    }
    if (!filter) return filtered
    const lc = filter.toLowerCase()
    return filtered.filter((e) => {
      const text = `${e.event} ${e.detail ?? ""}`
      return text.toLowerCase().includes(lc)
    })
  }, [events, filter, showHeartbeats])

  return {
    open,
    activeTab,
    filter,
    height,
    commands,
    events,
    showHeartbeats,
    toggle,
    close,
    setActiveTab,
    setFilter,
    setHeight,
    addCommand,
    addEvent,
    clearCommands,
    clearEvents,
    toggleHeartbeats,
    filteredCommands,
    filteredEvents,
  }
}
