// closed/total of a step's children for the selected molecule (beadbox-ptca.4).
// formulas-view provides the counts once; the step headers of both the tree and
// the DAG read them here, so the groups between them pass nothing through.

import { createContext, useContext } from "react"
import type { StepCount } from "../lib/types"
import { cn } from "../lib/utils"

export const StepCountsContext = createContext<Record<string, StepCount> | null>(null)

// compact: the smaller rows inside the graph view's step groups.
export function StepCountBadge({ stepId, compact }: { stepId: string; compact?: boolean }) {
  const count = useContext(StepCountsContext)?.[stepId]
  if (!count) return null
  const done = count.total > 0 && count.closed === count.total
  return (
    <span
      data-testid="step-count"
      data-step-id={stepId}
      aria-label={`${count.closed} of ${count.total} children closed`}
      className={cn(
        "py-0.5 rounded tabular-nums",
        compact ? "text-[10px] px-1" : "text-[11px] px-1.5",
        done ? "bg-green-500/15 text-green-400" : "bg-[#1e1e21] text-muted-foreground",
      )}
    >
      {count.closed}/{count.total}
    </span>
  )
}
