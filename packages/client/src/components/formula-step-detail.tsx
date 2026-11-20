import { X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FormulaStep } from "../lib/types"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

// Highlight {{variables}} and file paths in description text
const DESC_TOKEN_RE = /(\{\{[^}]+\}\}|(?:\/[\w./-]+|~\/[\w./-]+|\w+\/[\w./-]+)(?:\.\w+)?)/g

function formatDescription(text: string): React.ReactNode[] {
  const parts = text.split(DESC_TOKEN_RE)
  return parts.map((part, i) => {
    if (part.startsWith("{{")) {
      return (
        <span
          key={i}
          className="px-1 py-0.5 rounded bg-info/15 text-info-text border border-info/25"
        >
          {part.slice(2, -2)}
        </span>
      )
    }
    if (/^(\/|~\/|\w+\/)/.test(part) && part.includes("/")) {
      return (
        <span key={i} className="px-1 py-0.5 rounded bg-info/10 text-info-text">
          {part}
        </span>
      )
    }
    return <span key={i}>{part}</span>
  })
}

interface FormulaStepDetailProps {
  step: FormulaStep
  allSteps: FormulaStep[]
  onClose: () => void
  onNavigateToStep: (stepId: string) => void
}

export function FormulaStepDetail({
  step,
  allSteps,
  onClose,
  onNavigateToStep,
}: FormulaStepDetailProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Don't close the panel if a Radix Dialog is open (e.g. Preview/Pour modal).
        // Let the dialog handle its own Escape dismissal first.
        if (document.querySelector('[data-state="open"][role="dialog"]')) {
          return
        }
        e.preventDefault()
        onClose()
      }
    },
    [onClose],
  )

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleKeyDown])

  const [width, setWidth] = useState(340)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(340)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragging.current = true
      startX.current = e.clientX
      startW.current = width
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return
        const delta = startX.current - ev.clientX // drag left = wider
        setWidth(Math.max(240, Math.min(800, startW.current + delta)))
      }
      const onUp = () => {
        dragging.current = false
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [width],
  )

  const stepMap = new Map(allSteps.map((s) => [s.id, s]))
  const deps = (step.needs ?? []).map((id) => stepMap.get(id)).filter(Boolean) as FormulaStep[]
  const gateType = step.gate?.type

  return (
    <div
      className="relative border-l border-border/50 flex flex-col min-h-0 bg-background"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors z-10"
        onPointerDown={onPointerDown}
      />
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-border/50">
        <h3 className="text-[15px] font-semibold text-foreground leading-tight pt-0.5">
          {step.title}
        </h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onClose}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Close (Esc)</TooltipContent>
        </Tooltip>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Meta tags */}
        <div className="flex flex-wrap gap-1.5">
          {step.type && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-foreground">
              {step.type}
            </span>
          )}
          {step.assignee && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-foreground">
              @{step.assignee}
            </span>
          )}
          {gateType === "human" && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-warning/15 text-warning-text border border-warning/20">
              human gate
            </span>
          )}
          {gateType === "conditional" && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-info/15 text-info-text border border-info/20">
              conditional gate
            </span>
          )}
          {step.gate?.timeout && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              timeout: {step.gate.timeout}
            </span>
          )}
        </div>

        {/* Description */}
        {step.description && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">
              Description
            </div>
            <div className="bg-background rounded-md p-4 overflow-x-auto">
              <div className="text-[14px] text-muted-foreground whitespace-pre-line break-words leading-[1.7]">
                {formatDescription(step.description)}
              </div>
            </div>
          </div>
        )}

        {/* Dependencies */}
        {deps.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">
              Depends on
            </div>
            <div className="space-y-1">
              {deps.map((dep) => (
                <Tooltip key={dep.id}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => onNavigateToStep(dep.id)}
                      className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent/50 transition-colors"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                      <span className="truncate">{dep.title}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Navigate to this step</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
