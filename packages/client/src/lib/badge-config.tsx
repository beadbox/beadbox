import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Circle,
  CircleDot,
  Minus,
} from "lucide-react"
import type React from "react"
import type { BeadPriority } from "./types"
import { cn } from "./utils"

/**
 * `className` is the PRE-STYLESHEET fallback, not the final look: the status
 * and priority stylesheets (status-colors.ts) are unlayered and override it
 * once they mount — status rules only after the custom-status list loads.
 * It is written in tokens rather than palette literals so that window, and
 * any surface the stylesheet does not reach, is still legible in a light
 * theme. `-text` tokens are the per-surface derived values; never use the
 * bare tone token as text, which is tuned for fills.
 */
export type BadgeConfig = {
  label: string
  shortLabel?: string
  className: string
  icon: React.ReactNode
}

const coreStatusConfig: Record<string, BadgeConfig> = {
  open: {
    label: "Open",
    className: "bg-foreground/10 text-foreground border-foreground/30",
    icon: <Circle className="h-3 w-3" />,
  },
  in_progress: {
    label: "In Progress",
    className: "bg-warning/20 text-warning-text border-warning/40",
    icon: <CircleDot className="h-3 w-3" />,
  },
  closed: {
    label: "Closed",
    className: "bg-muted/40 text-muted-foreground border-border",
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
  ready_for_qa: {
    label: "Ready for QA",
    className: "bg-info/20 text-info-text border-info/40",
    icon: <CircleDot className="h-3 w-3" />,
  },
  ready_to_ship: {
    label: "Ready to Ship",
    className: "bg-success/20 text-success-text border-success/40",
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
}

export function getStatusConfig(status: string): BadgeConfig {
  if (coreStatusConfig[status]) {
    return coreStatusConfig[status]
  }
  return {
    label: status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    className: "bg-info/20 text-info-text border-info/40",
    icon: <Circle className="h-3 w-3" />,
  }
}

export const priorityConfig: Record<BeadPriority, BadgeConfig> = {
  critical: {
    label: "P0 - Critical",
    shortLabel: "P0",
    className: "bg-destructive/20 text-destructive-text border-destructive/40",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  high: {
    label: "P1 - High",
    shortLabel: "P1",
    className: "bg-warning/20 text-warning-text border-warning/40",
    icon: <ArrowUp className="h-3 w-3" />,
  },
  medium: {
    label: "P2 - Medium",
    shortLabel: "P2",
    className: "bg-warning/10 text-warning-text border-warning/25",
    icon: <Minus className="h-3 w-3" />,
  },
  low: {
    label: "P3 - Low",
    shortLabel: "P3",
    className: "bg-muted/40 text-muted-foreground border-border",
    icon: <ArrowDown className="h-3 w-3" />,
  },
  backlog: {
    label: "P4 - Backlog",
    shortLabel: "P4",
    className: "bg-muted/20 text-muted-foreground border-border/50",
    icon: <Circle className="h-3 w-3" />,
  },
}

const fallbackConfig: BadgeConfig = {
  label: "Unknown",
  className: "bg-muted/40 text-muted-foreground border-border",
  icon: <Circle className="h-3 w-3" />,
}

// beadbox-o3h: pass `status` for a status badge; it tags the element so a
// chosen status color (the injected stylesheet) recolors it. Pass `priority`
// for a priority badge, which is tagged the same way against the priority
// half of that stylesheet — that is what gives both per-surface text in a
// light theme instead of a baked `text-orange-400`.
export function PillBadge({
  config,
  status,
  priority,
  type,
}: {
  config: BadgeConfig | undefined
  status?: string
  priority?: BeadPriority
  type?: string
}) {
  const c = config || fallbackConfig
  return (
    <span
      data-status={status}
      data-status-role={status === undefined ? undefined : "badge"}
      data-priority={priority}
      data-priority-role={priority === undefined ? undefined : "badge"}
      data-type={type}
      data-type-role={type === undefined ? undefined : "badge"}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors whitespace-nowrap",
        c.className,
      )}
    >
      {c.icon}
      {c.shortLabel ? (
        <>
          <span className="pill-label-full">{c.label}</span>
          <span className="pill-label-short">{c.shortLabel}</span>
        </>
      ) : (
        c.label
      )}
    </span>
  )
}
