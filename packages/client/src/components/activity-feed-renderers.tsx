import { ArrowRight, MessageSquare, Pencil, Plus, Trash2 } from "lucide-react"
import { getStatusConfig } from "../lib/badge-config"
import type { ActivityEvent } from "../lib/types"
import { cn } from "../lib/utils"

export function EventIcon({ event }: { event: ActivityEvent }) {
  const iconClass = "h-3.5 w-3.5 shrink-0"
  switch (event.type) {
    case "create":
      return <Plus className={cn(iconClass, "text-emerald-400")} />
    case "status":
      return <ArrowRight className={cn(iconClass, "text-blue-400")} />
    case "comment":
      return <MessageSquare className={cn(iconClass, "text-purple-400")} />
    case "delete":
      return <Trash2 className={cn(iconClass, "text-red-400")} />
    case "update":
    default:
      return <Pencil className={cn(iconClass, "text-zinc-400")} />
  }
}

export function getActionSummary(
  event: ActivityEvent,
  navigable: boolean = false,
): React.ReactNode {
  const beadId = event.issue_id
  const idClass = cn(
    "font-mono text-xs",
    navigable
      ? "text-blue-400/80 group-hover:text-blue-400 group-hover:underline"
      : "text-muted-foreground",
  )

  switch (event.type) {
    case "create":
      return (
        <span>
          created <span className={idClass}>{beadId}</span>
        </span>
      )
    case "status": {
      const oldConfig = event.old_status ? getStatusConfig(event.old_status) : null
      const newConfig = event.new_status ? getStatusConfig(event.new_status) : null
      if (event.new_status === "closed") {
        return (
          <span>
            closed <span className={idClass}>{beadId}</span>
          </span>
        )
      }
      return (
        <span className="inline-flex items-center gap-1 flex-wrap">
          moved <span className={idClass}>{beadId}</span>
          {oldConfig && (
            <span
              data-status={event.old_status}
              data-status-role="badge"
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border",
                oldConfig.className,
              )}
            >
              {oldConfig.label}
            </span>
          )}
          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
          {newConfig && (
            <span
              data-status={event.new_status}
              data-status-role="badge"
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border",
                newConfig.className,
              )}
            >
              {newConfig.label}
            </span>
          )}
        </span>
      )
    }
    case "comment":
      return (
        <span>
          commented on <span className={idClass}>{beadId}</span>
        </span>
      )
    case "delete":
      return (
        <span>
          deleted <span className={idClass}>{beadId}</span>
        </span>
      )
    case "update":
    default:
      return (
        <span>
          updated <span className={idClass}>{beadId}</span>
        </span>
      )
  }
}

export function getCompactAction(event: ActivityEvent): React.ReactNode {
  switch (event.type) {
    case "create":
      return "created"
    case "status": {
      if (event.new_status === "closed") return "closed"
      const newConfig = event.new_status ? getStatusConfig(event.new_status) : null
      return (
        <span className="inline-flex items-center gap-1">
          {"moved to "}
          {newConfig && (
            <span
              data-status={event.new_status}
              data-status-role="badge"
              className={cn(
                "inline-flex items-center gap-1 px-1 py-0 rounded text-[10px] font-medium border",
                newConfig.className,
              )}
            >
              {newConfig.label}
            </span>
          )}
        </span>
      )
    }
    case "comment":
      return "commented"
    case "delete":
      return "deleted"
    case "update":
    default:
      return "updated"
  }
}
