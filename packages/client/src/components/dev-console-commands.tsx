import { Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { BdCommandEvent } from "../lib/console-types"
import { Button } from "./ui/button"

const TRUNCATE_LINES = 50

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function durationClass(ms: number): string {
  if (ms < 200) return "text-success-text"
  if (ms <= 500) return "text-warning-text"
  return "text-destructive-text"
}

function CommandEntry({ event }: { event: BdCommandEvent }) {
  const [expanded, setExpanded] = useState(false)
  const isError = event.exitCode !== 0
  const stdoutLines = event.stdout?.split("\n") ?? []
  const isTruncated = stdoutLines.length > TRUNCATE_LINES
  const visibleStdout = expanded ? event.stdout : stdoutLines.slice(0, TRUNCATE_LINES).join("\n")

  return (
    <div
      className={`px-3 py-1.5 text-xs font-mono ${isError ? "border-l-2 border-destructive" : ""}`}
      data-testid="command-entry"
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-muted-foreground shrink-0">{formatTime(event.timestamp)}</span>
        <span className="text-foreground">
          bd {event.command} {event.args.slice(1).join(" ")}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-[4.5rem] flex-wrap mt-0.5">
        <span className={durationClass(event.durationMs)}>{event.durationMs}ms</span>
        {isError ? (
          <span className="text-destructive font-semibold">ERR</span>
        ) : (
          <span className="text-success-text font-semibold">OK</span>
        )}
        {event.resultSummary && (
          <span className="text-muted-foreground">({event.resultSummary})</span>
        )}
        <span className="text-muted-foreground/60">
          [{event.source === "console" ? "user" : "app"}]
        </span>
      </div>
      {isError && event.stderr && (
        <div className="pl-[4.5rem] mt-0.5 text-destructive whitespace-pre-wrap break-all">
          {event.stderr}
        </div>
      )}
      {event.stdout && event.source === "console" && (
        <div className="pl-[4.5rem] mt-1 text-muted-foreground whitespace-pre-wrap break-all">
          {visibleStdout}
          {isTruncated && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="block mt-1 text-info-text/80 hover:text-info-text text-xs"
              data-testid="show-all-toggle"
            >
              Show all ({stdoutLines.length} lines)
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface DevConsoleCommandsProps {
  commands: BdCommandEvent[]
  dbPath?: string
  onExecute: (args: string[]) => Promise<void>
}

export function DevConsoleCommands({
  commands,
  dbPath: _dbPath,
  onExecute,
}: DevConsoleCommandsProps) {
  const [input, setInput] = useState("")
  const [executing, setExecuting] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const prevCountRef = useRef(commands.length)

  // Focus input when component mounts (console opens)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Auto-scroll on new entries when at bottom
  useEffect(() => {
    if (commands.length > prevCountRef.current && autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    prevCountRef.current = commands.length
  }, [commands.length, autoScroll])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50
    setAutoScroll(atBottom)
  }, [])

  const jumpToLatest = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      setAutoScroll(true)
    }
  }, [])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = input.trim()
      if (!trimmed) return

      // Strip "bd " prefix if present
      const cleaned = trimmed.startsWith("bd ") ? trimmed.slice(3) : trimmed
      const args = cleaned.split(/\s+/)
      if (args.length === 0 || !args[0]) return

      setExecuting(true)
      try {
        await onExecute(args)
      } finally {
        setExecuting(false)
        setInput("")
        inputRef.current?.focus()
      }
    },
    [input, onExecute],
  )

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable log area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden min-h-0"
        onScroll={handleScroll}
        data-testid="commands-scroll"
      >
        {commands.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            No commands yet. Navigate the app or type a command below.
          </div>
        )}
        {commands.map((cmd) => (
          <CommandEntry key={cmd.id} event={cmd} />
        ))}
      </div>

      {/* Jump to latest pill */}
      {!autoScroll && commands.length > 0 && (
        <div className="flex justify-center py-1">
          <button
            onClick={jumpToLatest}
            className="px-3 py-0.5 text-xs rounded-full bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
            data-testid="jump-to-latest"
          >
            Jump to latest
          </button>
        </div>
      )}

      {/* Input bar */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-3 py-2 border-t border-border"
        data-testid="command-input-form"
      >
        <span className="text-muted-foreground text-xs font-mono shrink-0">&gt;</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a bd command..."
          className="flex-1 bg-transparent text-xs font-mono text-foreground outline-none placeholder:text-muted-foreground/50"
          data-testid="command-input"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={executing || !input.trim()}
          className="h-6 px-2 text-xs"
        >
          {executing ? <Loader2 className="h-3 w-3 animate-spin" /> : "Run"}
        </Button>
      </form>
    </div>
  )
}
