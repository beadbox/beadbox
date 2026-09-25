// FORWARD-REF: P3.1 port of components/help-fab.tsx. The /api/help endpoint
// (Next.js route) does not yet exist in the SPA — a `rpc.help.ask()`
// handler + Tauri-side AI CLI integration is a follow-on chrome bead under
// bb-90zz. The fetch path below resolves to a 404 in plain browser dev,
// triggers the catch block, and the user sees the error message. The
// shape of the chrome is preserved so other components can mount HelpFab
// without breaking.

import { CircleHelp, Send, X } from "lucide-react"
import posthog from "posthog-js"
import { useCallback, useEffect, useRef, useState } from "react"
import { useViewport } from "../hooks/use-viewport"
import type { AiCliName } from "../lib/ai-cli-types"
import { cn } from "../lib/utils"
import { SimpleMarkdown } from "./simple-markdown"
import { Button } from "./ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { ScrollArea } from "./ui/scroll-area"
import { Spinner } from "./ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

function cliDisplayName(name: AiCliName): string {
  switch (name) {
    case "claude":
      return "Claude"
    case "codex":
      return "Codex"
    case "gemini":
      return "Gemini"
  }
}

export function HelpFab() {
  const [enabled, setEnabled] = useState(false)
  const { isMobile } = useViewport()
  useEffect(() => {
    try {
      setEnabled(!!posthog.isFeatureEnabled("enable-ai-help"))
    } catch {
      // PostHog not ready yet
    }
    const onFlags = () => {
      try {
        setEnabled(!!posthog.isFeatureEnabled("enable-ai-help"))
      } catch {
        // ignore
      }
    }
    posthog.onFeatureFlags?.(onFlags)
  }, [])

  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState("")
  const [response, setResponse] = useState("")
  const [cliName, setCliName] = useState<AiCliName | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Focus input when popover opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100)
    } else {
      // Cancel any in-flight request when closing
      abortRef.current?.abort()
    }
  }, [open])

  // Auto-scroll as response streams in
  useEffect(() => {
    // The streamed response changes the scroll height without replacing the element.
    void response
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [response])

  const handleSubmit = useCallback(async () => {
    const q = question.trim()
    if (!q || loading) return

    setLoading(true)
    setResponse("")
    setCliName(null)
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    // Detect current screen from pathname
    const screen =
      window.location.pathname === "/activity"
        ? "Activity tab"
        : window.location.pathname === "/trains"
          ? "Trains tab"
          : "Beads tab (main dashboard)"

    try {
      const res = await fetch("/api/help", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, screen }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const data = await res.json()
        if (data.error === "no_cli") {
          setError(data.message)
        } else {
          setError(data.error || "Something went wrong")
        }
        setLoading(false)
        return
      }

      if (!res.body) {
        setError("No response stream")
        setLoading(false)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ""
      let detectedCli = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        accumulated += text

        // Extract CLI name from first chunk marker
        if (!detectedCli && accumulated.includes("__cli:")) {
          const match = accumulated.match(/__cli:(\w+)__/)
          if (match) {
            setCliName(match[1] as AiCliName)
            accumulated = accumulated.replace(/__cli:\w+__/, "")
            detectedCli = true
          }
        }

        setResponse(detectedCli ? accumulated : accumulated.replace(/__cli:\w+__/, ""))
      }

      // Clear input after successful response so user can ask follow-ups
      setQuestion("")
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError("Failed to get response. Check that an AI CLI is installed.")
      }
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }, [question, loading])

  const handleClear = useCallback(() => {
    abortRef.current?.abort()
    setQuestion("")
    setResponse("")
    setCliName(null)
    setError(null)
    setLoading(false)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const hasResponse = response.length > 0 || error !== null

  if (!enabled) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className={cn(
                "inline-flex items-center justify-center rounded-md",
                "text-muted-foreground hover:text-foreground hover:bg-accent",
                "transition-colors",
                isMobile ? "min-h-[44px] min-w-[44px]" : "h-9 w-9",
              )}
              aria-label="AI Help"
            >
              <CircleHelp className="h-4 w-4" />
              <span className="sr-only">AI Help</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>AI Help</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[36rem] max-w-[calc(100vw-2rem)] p-0 overflow-hidden"
      >
        <div className="flex flex-col max-h-[32rem]">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
            <span className="text-sm font-medium text-foreground/70">
              {loading && cliName
                ? `Asking ${cliDisplayName(cliName)}...`
                : cliName
                  ? `Answered by ${cliDisplayName(cliName)}`
                  : "Ask a question"}
            </span>
            {hasResponse && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleClear}
                className="size-6"
                aria-label="Clear"
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>

          {/* Response area */}
          {hasResponse && (
            <ScrollArea className="flex-1 min-h-0 max-h-96">
              <div ref={scrollRef} className="px-3 py-2 overflow-y-auto max-h-96">
                {error ? (
                  <p className="text-sm text-muted-foreground">{error}</p>
                ) : (
                  <SimpleMarkdown content={response} className="[overflow-wrap:break-word]" />
                )}
                {loading && (
                  <div className="flex items-center gap-2 mt-2">
                    <Spinner className="size-3" />
                    <span className="text-xs text-muted-foreground">Thinking...</span>
                  </div>
                )}
              </div>
            </ScrollArea>
          )}

          {/* Input area */}
          <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
            <input
              ref={inputRef}
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              placeholder="How do I archive a bead?"
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
              disabled={loading}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleSubmit}
              disabled={!question.trim() || loading}
              className="size-7 shrink-0"
              aria-label="Send"
            >
              {loading ? <Spinner className="size-3.5" /> : <Send className="size-3.5" />}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
