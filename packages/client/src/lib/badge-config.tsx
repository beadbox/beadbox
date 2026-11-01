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

export type BadgeConfig = {
  label: string
  shortLabel?: string
  className: string
  icon: React.ReactNode
}

const coreStatusConfig: Record<string, BadgeConfig> = {
  open: {
    label: "Open",
    className: "bg-white/10 text-white border-white/30",
    icon: <Circle className="h-3 w-3" />,
  },
  in_progress: {
    label: "In Progress",
    className: "bg-amber-500/20 text-amber-400 border-amber-500/40",
    icon: <CircleDot className="h-3 w-3" />,
  },
  closed: {
    label: "Closed",
    className: "bg-zinc-600/20 text-zinc-400 border-zinc-500/40",
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
  ready_for_qa: {
    label: "Ready for QA",
    className: "bg-purple-500/20 text-purple-400 border-purple-500/40",
    icon: <CircleDot className="h-3 w-3" />,
  },
  ready_to_ship: {
    label: "Ready to Ship",
    className: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
}

export function getStatusConfig(status: string): BadgeConfig {
  if (coreStatusConfig[status]) {
    return coreStatusConfig[status]
  }
  return {
    label: status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    className: "bg-blue-500/20 text-blue-400 border-blue-500/40",
    icon: <Circle className="h-3 w-3" />,
  }
}

export const priorityConfig: Record<BeadPriority, BadgeConfig> = {
  critical: {
    label: "P0 - Critical",
    shortLabel: "P0",
    className: "bg-red-500/20 text-red-400 border-red-500/40",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  high: {
    label: "P1 - High",
    shortLabel: "P1",
    className: "bg-orange-500/20 text-orange-400 border-orange-500/40",
    icon: <ArrowUp className="h-3 w-3" />,
  },
  medium: {
    label: "P2 - Medium",
    shortLabel: "P2",
    className: "bg-yellow-500/10 text-yellow-500/70 border-yellow-500/25",
    icon: <Minus className="h-3 w-3" />,
  },
  low: {
    label: "P3 - Low",
    shortLabel: "P3",
    className: "bg-slate-500/20 text-slate-400 border-slate-500/40",
    icon: <ArrowDown className="h-3 w-3" />,
  },
  backlog: {
    label: "P4 - Backlog",
    shortLabel: "P4",
    className: "bg-zinc-500/10 text-zinc-500 border-zinc-500/25",
    icon: <Circle className="h-3 w-3" />,
  },
}

const fallbackConfig: BadgeConfig = {
  label: "Unknown",
  className: "bg-slate-500/20 text-slate-400 border-slate-500/40",
  icon: <Circle className="h-3 w-3" />,
}

// beadbox-o3h: pass `status` for a status badge; it tags the element so a
// chosen status color (the injected stylesheet) recolors it.
export function PillBadge({
  config,
  status,
}: {
  config: BadgeConfig | undefined
  status?: string
}) {
  const c = config || fallbackConfig
  return (
    <span
      data-status={status}
      data-status-role={status === undefined ? undefined : "badge"}
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
