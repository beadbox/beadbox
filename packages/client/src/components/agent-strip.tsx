import { HelpCircle } from "lucide-react"
import { formatRelativeTime } from "../lib/activity-utils"
import type { AgentState, CrossFilter } from "../lib/types"
import { cn } from "../lib/utils"
import { CopyableId } from "./copyable-id"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { Skeleton } from "./ui/skeleton"

interface AgentStripProps {
  agents: AgentState[]
  crossFilter: CrossFilter
  onAgentClick: (agentName: string) => void
  loading?: boolean
  focusedIndex?: number | null
}

const STATUS_DOT_COLORS: Record<AgentState["status"], string> = {
  active: "bg-success",
  quiet: "bg-warning",
  silent: "bg-destructive",
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "…"
}

function AgentsLabel() {
  return (
    <div className="flex items-center gap-1.5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Agents
      </h2>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground/60 hover:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm"
            aria-label="How the agent list works"
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 text-sm space-y-2">
          <p className="font-medium">How this list is built</p>
          <p className="text-muted-foreground">
            Agents appear here when they interact with beads (status changes, comments,
            assignments). Each card shows their most recent action.
          </p>
          <p className="text-muted-foreground">
            Agent names are derived from the assignee field on beads.
          </p>
          <div className="space-y-1 text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-success shrink-0" />
              <span>Active in the last 5 minutes</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-warning shrink-0" />
              <span>Quiet (5 to 30 minutes)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-destructive shrink-0" />
              <span>Silent (30+ minutes)</span>
            </div>
          </div>
          <p className="text-muted-foreground">
            The list resets on page reload. Click an agent card to filter beads by that agent.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function AgentStrip({
  agents,
  crossFilter,
  onAgentClick,
  loading = false,
  focusedIndex = null,
}: AgentStripProps) {
  const activeCount = agents.filter((a) => a.status === "active").length

  if (loading && agents.length === 0) {
    return (
      <section aria-label="Agent status strip">
        <div className="flex items-center justify-between mb-3">
          <AgentsLabel />
        </div>
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="min-w-[160px] max-w-[200px] h-[120px] rounded-lg" />
          ))}
        </div>
      </section>
    )
  }

  if (!loading && agents.length === 0) {
    return (
      <section aria-label="Agent status strip">
        <div className="flex items-center justify-between mb-3">
          <AgentsLabel />
        </div>
        <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
          No agent activity yet
        </div>
      </section>
    )
  }

  return (
    <section aria-label="Agent status strip">
      <div className="flex items-center justify-between mb-3">
        <AgentsLabel />
        <span className="text-xs text-muted-foreground">{activeCount} active now</span>
      </div>

      <div className="flex flex-wrap gap-3">
        {agents.map((agent, idx) => {
          const isSelected = crossFilter.type === "agent" && crossFilter.value === agent.name
          const isDimmed = crossFilter.type === "stage" && crossFilter.value !== null
          const hasActivity = Boolean(agent.lastBeadId)

          return (
            <button
              key={agent.name}
              type="button"
              onClick={() => onAgentClick(agent.name)}
              className={cn(
                "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-all",
                "min-w-[160px] max-w-[200px]",
                "bg-card hover:bg-accent/50",
                isSelected && "ring-2 ring-primary border-primary",
                focusedIndex === idx && !isSelected && "ring-2 ring-info/60 border-info/60",
                isDimmed && "opacity-50",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn("h-2 w-2 rounded-full shrink-0", STATUS_DOT_COLORS[agent.status])}
                  aria-label={`Status: ${agent.status}`}
                />
                <span className="text-sm font-semibold truncate">{agent.name}</span>
              </div>

              {hasActivity ? (
                <>
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <CopyableId id={agent.lastBeadId} className="text-xs !min-w-0" />
                  </div>
                  <span className="text-xs text-muted-foreground truncate">
                    {truncate(agent.lastBeadTitle, 30)}
                  </span>
                  <span className="text-xs text-muted-foreground">{agent.lastAction}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(agent.lastSeen)}
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted-foreground italic">no recent activity</span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
