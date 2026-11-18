import { ChevronRight, HelpCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { formatTypeSummary } from "../lib/activity-utils"
import { getStatusDisplayLabel } from "../lib/status-chain"
import type { CrossFilter, PipelineStage } from "../lib/types"
import { cn } from "../lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { Spinner } from "./ui/spinner"

interface PipelineFlowProps {
  stages: PipelineStage[]
  crossFilter: CrossFilter
  onStageClick: (stageName: string) => void
  onBeadClick: (beadId: string) => void
  beadsMovedToday: number
  loading?: boolean
}

// Pre-stylesheet fallbacks only. Every tile below carries data-status with
// the "stage" role and its label the "text" role, so the injected stylesheet
// supplies the real hue — including any colour chosen in Settings. These are
// what shows in the window before the custom-status list loads, tokenised so
// that window is legible in a light theme too.
const STAGE_COLORS: Record<string, string> = {
  backlog: "bg-muted/30 border-border",
  open: "bg-foreground/10 border-foreground/30",
  in_progress: "bg-warning/20 border-warning/40",
  ready_for_qa: "bg-info/20 border-info/40",
  ready_to_ship: "bg-success/20 border-success/40",
  closed: "bg-muted/40 border-border",
}

const STAGE_TEXT_COLORS: Record<string, string> = {
  backlog: "text-muted-foreground",
  open: "text-foreground",
  in_progress: "text-warning-text",
  ready_for_qa: "text-info-text",
  ready_to_ship: "text-success-text",
  closed: "text-muted-foreground/70",
}

// beadbox-8k3: STAGE_LABELS removed — labels are now derived dynamically
// via getStatusDisplayLabel(stage.name) so workspaces with arbitrary
// status.custom chains get correct title-casing without per-status entries
// in this file. STAGE_COLORS / STAGE_TEXT_COLORS are kept as a recognized-
// stage palette with a default fallback for unknown statuses.

// Loading-state placeholders default to the always-present built-in
// trio. Activity-page replaces these with the real chain once
// getAvailableStatuses resolves.
const LOADING_STAGES = ["open", "in_progress", "closed"]

export function PipelineFlow({
  stages,
  crossFilter,
  onStageClick,
  onBeadClick,
  beadsMovedToday,
  loading = false,
}: PipelineFlowProps) {
  const prevCountsRef = useRef<Record<string, number>>({})
  const [pulsingStages, setPulsingStages] = useState<Set<string>>(new Set())

  useEffect(() => {
    const prev = prevCountsRef.current
    const nowPulsing = new Set<string>()

    for (const stage of stages) {
      const prevCount = prev[stage.name] ?? 0
      if (stage.count > prevCount && prevCount > 0) {
        nowPulsing.add(stage.name)
      }
    }

    if (nowPulsing.size > 0) {
      setPulsingStages(nowPulsing)

      const timer = setTimeout(() => {
        setPulsingStages(new Set())
      }, 1000)

      const newCounts: Record<string, number> = {}
      for (const stage of stages) {
        newCounts[stage.name] = stage.count
      }
      prevCountsRef.current = newCounts

      return () => clearTimeout(timer)
    }

    const newCounts: Record<string, number> = {}
    for (const stage of stages) {
      newCounts[stage.name] = stage.count
    }
    prevCountsRef.current = newCounts
  }, [stages])

  const isSelected = crossFilter.type === "stage"

  return (
    <section aria-label="Pipeline">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Pipeline
          </h2>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground/60 hover:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm"
                aria-label="How the pipeline works"
              >
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 text-sm space-y-2">
              <p className="font-medium">How the pipeline works</p>
              <p className="text-muted-foreground">
                Each column represents a workflow stage. The count shows how many beads are
                currently in that stage.
              </p>
              <p className="text-muted-foreground">
                Counts update in real-time as beads move through the workflow.
              </p>
              <p className="text-muted-foreground">
                Click a column to filter the bead table by that status.
              </p>
            </PopoverContent>
          </Popover>
        </div>
        <span className="text-xs text-muted-foreground">
          {beadsMovedToday} bead{beadsMovedToday !== 1 ? "s" : ""} moved today
        </span>
      </div>

      <div className="flex items-stretch gap-0">
        {loading && stages.length === 0
          ? LOADING_STAGES.map((name, idx) => (
              <div key={name} className="flex items-stretch">
                {idx > 0 && (
                  <div className="flex items-center px-1.5">
                    <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                )}
                <div
                  data-status={name}
                  data-status-role="stage"
                  className={cn(
                    "flex-1 min-w-[140px] rounded-lg border px-4 py-3 flex flex-col items-center justify-center",
                    STAGE_COLORS[name] ?? "bg-info/20 border-info/40",
                    "opacity-50",
                  )}
                >
                  <span
                    data-status={name}
                    data-status-role="text"
                    className={cn(
                      "text-xs font-medium uppercase tracking-wide mb-3",
                      STAGE_TEXT_COLORS[name] ?? "text-info-text",
                    )}
                  >
                    {getStatusDisplayLabel(name)}
                  </span>
                  <Spinner className="h-5 w-5 text-muted-foreground" />
                </div>
              </div>
            ))
          : stages.map((stage, idx) => {
              const selected = isSelected && crossFilter.value === stage.name
              const dimmed = isSelected && !selected
              const pulsing = pulsingStages.has(stage.name)

              return (
                <div key={stage.name} className="flex items-stretch">
                  {idx > 0 && (
                    <div className="flex items-center px-1.5">
                      <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => onStageClick(stage.name)}
                    className={cn(
                      "flex-1 min-w-[140px] rounded-lg border px-4 py-3 text-left transition-all cursor-pointer",
                      STAGE_COLORS[stage.name] ?? "bg-info/20 border-info/40",
                      selected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                      dimmed && "opacity-40",
                      pulsing && "animate-pipeline-pulse",
                    )}
                    aria-pressed={selected}
                    data-stage={stage.name}
                    data-status={stage.name}
                    data-status-role="stage"
                  >
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span
                        data-status={stage.name}
                        data-status-role="text"
                        className={cn(
                          "text-xs font-medium uppercase tracking-wide",
                          STAGE_TEXT_COLORS[stage.name] ?? "text-info-text",
                        )}
                      >
                        {getStatusDisplayLabel(stage.name)}
                      </span>
                    </div>

                    <div
                      data-status={stage.name}
                      data-status-role="text"
                      className={cn(
                        "text-2xl font-bold tabular-nums",
                        STAGE_TEXT_COLORS[stage.name] ?? "text-info-text",
                      )}
                    >
                      {stage.count}
                    </div>

                    {stage.count > 0 && Object.keys(stage.typeCounts).length > 0 && (
                      <div className="text-xs text-muted-foreground mt-1">
                        {formatTypeSummary(stage.typeCounts)}
                      </div>
                    )}

                    {stage.displayIds.length > 0 && (
                      <div className="mt-2 space-y-0.5">
                        {stage.displayIds.map((id) => (
                          <div
                            key={id}
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation()
                              onBeadClick(id)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.stopPropagation()
                                e.preventDefault()
                                onBeadClick(id)
                              }
                            }}
                            className="block font-mono text-xs text-muted-foreground hover:text-primary hover:underline underline-offset-2 transition-colors cursor-pointer"
                          >
                            {id}
                          </div>
                        ))}
                        {stage.overflow > 0 && (
                          <span className="block text-xs text-muted-foreground/60">
                            +{stage.overflow} more
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                </div>
              )
            })}
      </div>
    </section>
  )
}
