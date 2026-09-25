"use client"

import {
  Archive,
  Bot,
  Bug,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FileText,
  Flag,
  Ghost,
  GitMerge,
  Hexagon,
  Layers,
  ListTodo,
  Loader2,
  MessageSquare,
  Server,
  ShieldCheck,
  Sparkles,
  Timer,
  Trash2,
  Truck,
  UserCog,
  Waves,
  Wrench,
  Zap,
} from "lucide-react"
import { useState } from "react"
import { CopyableId } from "@/components/copyable-id"
import { Checkbox } from "@/components/ui/checkbox"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useViewport } from "@/hooks/use-viewport"
import { type BadgeConfig, getStatusConfig, PillBadge, priorityConfig } from "@/lib/badge-config"
import { getUnreadReason, isBeadUnread } from "@/lib/local-storage"
import type { GateInfo } from "@/lib/molecule-phases"
import type { Bead, ReadState } from "@/lib/types"
import { cn } from "@/lib/utils"

interface BeadTableProps {
  beads: Bead[]
  onBeadClick: (bead: Bead) => void
  onArchive?: (beadId: string) => Promise<void>
  onDelete?: (beadId: string) => void
  epicId: string
  onDragStart?: (beadId: string) => void
  onDragEnd?: () => void
  draggedBeadId?: string | null
  expandedBeads?: Set<string>
  onToggleBead?: (beadId: string) => void
  focusedItemId?: string | null
  onFocusItem?: (id: string | null) => void
  selectedBeadId?: string | null
  showWaves?: boolean
  readState?: ReadState
  // bb-y729: optional bulk-select wiring. When present, renders a checkbox
  // column. Callers that opt out (omitting these) keep the legacy layout.
  // Each BeadTable instance derives its own select-all/indeterminate state
  // from `selectedIds` ∩ its own `beads` — selection set itself is shared
  // across mount sites by the page-level owner.
  selectedIds?: Set<string>
  onToggleSelect?: (beadId: string) => void
  onToggleSelectAll?: (visibleIds: string[]) => void
}

interface Wave {
  wave: number
  beads: Bead[]
}

function computeWaves(beads: Bead[]): Wave[] {
  if (beads.length === 0) return []

  // Build set of sibling IDs (beads in this list)
  const siblingIds = new Set(beads.map((b) => b.id))

  // Map each bead to its local blockers (blockedBy entries that are siblings)
  const localBlockers = new Map<string, Set<string>>()
  for (const bead of beads) {
    const blockers = new Set<string>()
    if (bead.blockedBy) {
      for (const dep of bead.blockedBy) {
        if (siblingIds.has(dep.id)) {
          blockers.add(dep.id)
        }
      }
    }
    localBlockers.set(bead.id, blockers)
  }

  // Topological level assignment
  const waveOf = new Map<string, number>()
  const assigned = new Set<string>()

  // Iteratively assign waves
  let currentWave = 1
  let remaining = [...beads]

  while (remaining.length > 0) {
    const thisWave: string[] = []

    for (const bead of remaining) {
      const blockers = localBlockers.get(bead.id)!
      // All local blockers must already be assigned to a previous wave
      const allBlockersResolved = [...blockers].every((b) => assigned.has(b))
      if (allBlockersResolved) {
        thisWave.push(bead.id)
      }
    }

    // If no beads could be assigned, we have a cycle. Dump all remaining into current wave.
    if (thisWave.length === 0) {
      for (const bead of remaining) {
        waveOf.set(bead.id, currentWave)
      }
      break
    }

    for (const id of thisWave) {
      waveOf.set(id, currentWave)
      assigned.add(id)
    }

    remaining = remaining.filter((b) => !assigned.has(b.id))
    currentWave++
  }

  // Group beads by wave, preserving original order within each wave
  const waveGroups = new Map<number, Bead[]>()
  for (const bead of beads) {
    const w = waveOf.get(bead.id) ?? 1
    if (!waveGroups.has(w)) {
      waveGroups.set(w, [])
    }
    waveGroups.get(w)!.push(bead)
  }

  // Sort by wave number and return
  return Array.from(waveGroups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([wave, waveBeads]) => ({ wave, beads: waveBeads }))
}

// Depth-based left border colors for nested subtasks
const depthBorderColors = [
  "",
  "border-l-2 border-l-blue-500/50",
  "border-l-2 border-l-cyan-500/50",
  "border-l-2 border-l-teal-500/50",
  "border-l-2 border-l-emerald-500/50",
]

interface BeadRowProps {
  bead: Bead
  depth: number
  onBeadClick: (bead: Bead) => void
  onArchive?: (beadId: string) => Promise<void>
  onDelete?: (beadId: string) => void
  epicId: string
  onDragStart?: (beadId: string) => void
  onDragEnd?: () => void
  draggedBeadId?: string | null
  expandedBeads?: Set<string>
  onToggleBead?: (beadId: string) => void
  focusedItemId?: string | null
  onFocusItem?: (id: string | null) => void
  selectedBeadId?: string | null
  readState?: ReadState
  selectedIds?: Set<string>
  onToggleSelect?: (beadId: string) => void
}

function BeadRow({
  bead,
  depth,
  onBeadClick,
  onArchive,
  onDelete,
  epicId,
  onDragStart,
  onDragEnd,
  draggedBeadId,
  expandedBeads,
  onToggleBead,
  focusedItemId,
  onFocusItem,
  selectedBeadId,
  readState,
  selectedIds,
  onToggleSelect,
}: BeadRowProps) {
  const { isMobile } = useViewport()
  const [isArchiving, setIsArchiving] = useState(false)
  const isSelected = selectedIds?.has(bead.id) ?? false
  const hasChildren = bead.children && bead.children.length > 0
  const isExpanded = expandedBeads?.has(bead.id) ?? false
  const borderColor = depthBorderColors[Math.min(depth, depthBorderColors.length - 1)]
  const indentPadding = depth > 0 ? `${depth * 16}px` : undefined

  return (
    <>
      <div
        draggable
        data-item-id={bead.id}
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/x-bead-move",
            JSON.stringify({ beadId: bead.id, sourceEpicId: epicId, type: "bead" }),
          )
          e.dataTransfer.effectAllowed = "move"
          onDragStart?.(bead.id)
        }}
        onDragEnd={() => onDragEnd?.()}
        className={cn(
          "bead-row group flex items-center gap-x-2 gap-y-1 px-3 py-2 border-b border-border/50 hover:bg-white/5 cursor-grab active:cursor-grabbing transition-colors select-none",
          borderColor,
          hasChildren && "bg-white/[0.05]",
          draggedBeadId === bead.id && "opacity-50",
          focusedItemId === bead.id && "ring-1 ring-primary/60 border-l-2 border-l-primary",
          selectedBeadId === bead.id && "bg-primary/15",
        )}
        style={{ paddingLeft: indentPadding ? `calc(0.75rem + ${indentPadding})` : undefined }}
        onClick={() => {
          onFocusItem?.(bead.id)
          onBeadClick(bead)
        }}
      >
        {/* bb-y729: bulk-select checkbox (only when wired by parent) */}
        {onToggleSelect && (
          <div
            className="bead-row-select shrink-0 flex items-center"
            onClick={(e) => {
              e.stopPropagation()
            }}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelect(bead.id)}
              aria-label={`Select bead ${bead.id}`}
            />
          </div>
        )}
        {/* Row 1: chevron + ID + type */}
        <div className="bead-row-id flex items-center gap-1 shrink-0">
          {hasChildren ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleBead?.(bead.id)
                  }}
                  className={cn(
                    "p-0.5 -ml-1 mr-1 text-muted-foreground hover:text-foreground transition-colors",
                    isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                  )}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {isExpanded ? "Collapse subtasks" : "Expand subtasks"}
              </TooltipContent>
            </Tooltip>
          ) : depth > 0 || hasChildren === false ? (
            <span className="w-5 -ml-1 mr-1" />
          ) : null}
          <CopyableId id={bead.id} />
        </div>
        <div className="bead-row-type shrink-0">
          <PillBadge
            config={
              typeConfig[bead.type] ?? {
                label: bead.type,
                className: "bg-slate-500/20 text-slate-400 border-slate-500/40",
                icon: <Hexagon className="h-3 w-3" />,
              }
            }
          />
        </div>
        {bead.specId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <FileText className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            </TooltipTrigger>
            <TooltipContent>{bead.specId}</TooltipContent>
          </Tooltip>
        )}
        {bead.dueAt && (
          <Tooltip>
            <TooltipTrigger asChild>
              <CalendarClock
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  new Date(bead.dueAt) < new Date() ? "text-red-400" : "text-muted-foreground/50",
                )}
              />
            </TooltipTrigger>
            <TooltipContent>
              Due:{" "}
              {new Date(bead.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </TooltipContent>
          </Tooltip>
        )}
        {bead.estimatedMinutes && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Timer className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            </TooltipTrigger>
            <TooltipContent>
              {bead.estimatedMinutes >= 60
                ? `~${Math.round(bead.estimatedMinutes / 60)}h`
                : `~${bead.estimatedMinutes}m`}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Spacer for wide layout */}
        <div className="bead-row-spacer flex-1" />

        {/* Archive button */}
        {onArchive && (
          <div className="bead-row-archive shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={isArchiving}
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsArchiving(true)
                    onArchive(bead.id).finally(() => setIsArchiving(false))
                  }}
                  className={cn(
                    "p-1.5 rounded hover:bg-amber-500/20 text-muted-foreground hover:text-amber-400 transition-colors opacity-0 group-hover:opacity-100",
                    isMobile &&
                      "min-h-[44px] min-w-[44px] flex items-center justify-center opacity-100",
                  )}
                >
                  {isArchiving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Archive className="h-4 w-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>Archive bead</TooltipContent>
            </Tooltip>
          </div>
        )}
        {/* Delete button */}
        {onDelete && (
          <div className="bead-row-delete shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(bead.id)
                  }}
                  className={cn(
                    "p-1.5 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100",
                    isMobile &&
                      "min-h-[44px] min-w-[44px] flex items-center justify-center opacity-100",
                  )}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Delete bead</TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Row 2: title + dependency chip + status + priority + assignee */}
        <div className="bead-row-title flex-1 text-left min-w-0 flex items-center gap-2 overflow-hidden">
          {readState && isBeadUnread(bead, readState) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-400" />
              </TooltipTrigger>
              <TooltipContent>{getUnreadReason(bead, readState) ?? "Unread"}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="shrink-0 w-1.5 h-1.5" />
          )}
          <span className="font-medium text-foreground/70 truncate min-w-[80px]">{bead.title}</span>
          {(bead as Bead & { gate?: GateInfo }).gate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0",
                    (bead as Bead & { gate?: GateInfo }).gate!.status === "closed"
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-amber-500/15 text-amber-400",
                  )}
                >
                  <ShieldCheck className="h-3 w-3" />
                  {(bead as Bead & { gate?: GateInfo }).gate!.type}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {(bead as Bead & { gate?: GateInfo }).gate!.status === "closed"
                  ? "Gate resolved"
                  : "Gate pending"}{" "}
                ({(bead as Bead & { gate?: GateInfo }).gate!.id})
              </TooltipContent>
            </Tooltip>
          )}
          {bead.orphanedFromEpic && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-muted/40 text-muted-foreground/60 border border-muted-foreground/20 shrink-0">
                  <Ghost className="h-3 w-3" />
                  {bead.orphanedFromEpic.title}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Parent epic is closed or archived: {bead.orphanedFromEpic.id}
              </TooltipContent>
            </Tooltip>
          )}
          {bead.blockedBy && bead.blockedBy.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-500/10 text-slate-400 border border-slate-500/20 min-w-0 max-w-[200px] truncate">
                  after{" "}
                  {bead.blockedBy
                    .map((dep) => {
                      const depParts = dep.id.split(".")
                      const beadParts = bead.id.split(".")
                      if (
                        depParts.length > 1 &&
                        beadParts.length > 1 &&
                        depParts[0] === beadParts[0]
                      ) {
                        return `.${depParts.slice(1).join(".")}`
                      }
                      return dep.id
                    })
                    .join(", ")}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Blocked by {bead.blockedBy.map((dep) => dep.id).join(", ")}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="bead-row-status shrink-0">
          <PillBadge config={getStatusConfig(bead.status)} />
        </div>
        <div className="bead-row-priority shrink-0">
          <PillBadge config={priorityConfig[bead.priority]} />
        </div>
        {bead.rigName && (
          <div className="bead-row-rig shrink-0">
            <span className="text-xs text-muted-foreground/60 font-mono">{bead.rigName}</span>
          </div>
        )}
        <div className="bead-row-assignee shrink-0 text-muted-foreground text-sm">
          {bead.assignee || (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground/40 cursor-default">-</span>
              </TooltipTrigger>
              <TooltipContent>Unassigned</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {/* Render children if expanded */}
      {hasChildren &&
        isExpanded &&
        bead.children!.map((child, idx) => (
          <BeadRow
            key={`${child.id}-${idx}`}
            bead={child}
            depth={depth + 1}
            onBeadClick={onBeadClick}
            onArchive={onArchive}
            onDelete={onDelete}
            epicId={epicId}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            draggedBeadId={draggedBeadId}
            expandedBeads={expandedBeads}
            onToggleBead={onToggleBead}
            focusedItemId={focusedItemId}
            onFocusItem={onFocusItem}
            selectedBeadId={selectedBeadId}
            readState={readState}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
          />
        ))}
    </>
  )
}

const typeConfig: Record<string, BadgeConfig> = {
  bug: {
    label: "Bug",
    className: "bg-red-500/20 text-red-400 border-red-500/40",
    icon: <Bug className="h-3 w-3" />,
  },
  task: {
    label: "Task",
    className: "bg-blue-500/20 text-blue-400 border-blue-500/40",
    icon: <ListTodo className="h-3 w-3" />,
  },
  feature: {
    label: "Feature",
    className: "bg-purple-500/20 text-purple-400 border-purple-500/40",
    icon: <Sparkles className="h-3 w-3" />,
  },
  epic: {
    label: "Epic",
    className: "bg-amber-500/20 text-amber-400 border-amber-500/40",
    icon: <Layers className="h-3 w-3" />,
  },
  milestone: {
    label: "Milestone",
    className: "bg-sky-500/20 text-sky-400 border-sky-500/40",
    icon: <Flag className="h-3 w-3" />,
  },
  chore: {
    label: "Chore",
    className: "bg-slate-500/20 text-slate-400 border-slate-500/40",
    icon: <Wrench className="h-3 w-3" />,
  },
  message: {
    label: "Message",
    className: "bg-cyan-500/20 text-cyan-400 border-cyan-500/40",
    icon: <MessageSquare className="h-3 w-3" />,
  },
  gate: {
    label: "Gate",
    className: "bg-green-500/20 text-green-400 border-green-500/40",
    icon: <ShieldCheck className="h-3 w-3" />,
  },
  "merge-request": {
    label: "MR",
    className: "bg-teal-500/20 text-teal-400 border-teal-500/40",
    icon: <GitMerge className="h-3 w-3" />,
  },
  molecule: {
    label: "Molecule",
    className: "bg-pink-500/20 text-pink-400 border-pink-500/40",
    icon: <Hexagon className="h-3 w-3" />,
  },
  agent: {
    label: "Agent",
    className: "bg-violet-500/20 text-violet-400 border-violet-500/40",
    icon: <Bot className="h-3 w-3" />,
  },
  role: {
    label: "Role",
    className: "bg-sky-500/20 text-sky-400 border-sky-500/40",
    icon: <UserCog className="h-3 w-3" />,
  },
  rig: {
    label: "Rig",
    className: "bg-orange-500/20 text-orange-400 border-orange-500/40",
    icon: <Server className="h-3 w-3" />,
  },
  convoy: {
    label: "Convoy",
    className: "bg-lime-500/20 text-lime-400 border-lime-500/40",
    icon: <Truck className="h-3 w-3" />,
  },
  event: {
    label: "Event",
    className: "bg-rose-500/20 text-rose-400 border-rose-500/40",
    icon: <Zap className="h-3 w-3" />,
  },
}

export function BeadTable({
  beads,
  onBeadClick,
  onArchive,
  onDelete,
  epicId,
  onDragStart,
  onDragEnd,
  draggedBeadId,
  expandedBeads,
  onToggleBead,
  focusedItemId,
  onFocusItem,
  selectedBeadId,
  showWaves,
  readState,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: BeadTableProps) {
  const waves = showWaves ? computeWaves(beads) : null
  const useWaveView = waves && waves.length >= 2

  const renderBeadRow = (bead: Bead, index: number) => (
    <BeadRow
      key={`${bead.id}-${index}`}
      bead={bead}
      depth={0}
      onBeadClick={onBeadClick}
      onArchive={onArchive}
      onDelete={onDelete}
      epicId={epicId}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      draggedBeadId={draggedBeadId}
      expandedBeads={expandedBeads}
      onToggleBead={onToggleBead}
      focusedItemId={focusedItemId}
      onFocusItem={onFocusItem}
      selectedBeadId={selectedBeadId}
      readState={readState}
      selectedIds={selectedIds}
      onToggleSelect={onToggleSelect}
    />
  )

  // bb-y729: derive this table's own select-all state from the shared
  // `selectedIds` ∩ this table's top-level beads (children counted only when
  // expanded would over-collect; first cut keeps select-all to top-level
  // rows the user can see in the header view).
  const visibleIds = beads.map((b) => b.id)
  let selectedHits = 0
  if (selectedIds) {
    for (const id of visibleIds) {
      if (selectedIds.has(id)) selectedHits++
    }
  }
  const headerCheckedState: boolean | "indeterminate" =
    visibleIds.length === 0
      ? false
      : selectedHits === visibleIds.length
        ? true
        : selectedHits > 0
          ? "indeterminate"
          : false

  return (
    <div className="bead-table-container">
      {/* Header row: hidden on narrow, visible on wide */}
      <div className="bead-row-header items-center gap-2 px-3 py-2 text-xs text-muted-foreground border-b border-border/50">
        {onToggleSelectAll && (
          <div className="bead-row-select-header shrink-0 flex items-center">
            <Checkbox
              checked={headerCheckedState}
              onCheckedChange={() => onToggleSelectAll(visibleIds)}
              aria-label="Select all visible beads"
            />
          </div>
        )}
        <div className="w-24 shrink-0 pl-5">ID</div>
        <div className="w-20 shrink-0">Type</div>
        <div className="flex-1">Title</div>
        <div className="w-28 shrink-0">Status</div>
        <div className="w-24 shrink-0">Priority</div>
        <div className="w-24 shrink-0">Assignee</div>
        {onDelete && <div className="w-10 shrink-0"></div>}
      </div>
      {/* Bead rows */}
      <div>
        {useWaveView
          ? waves.map((wave) => (
              <div
                key={`wave-${wave.wave}`}
                className={cn(
                  "border-b border-border/20",
                  wave.wave % 2 === 0 && "bg-white/[0.025]",
                )}
              >
                <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground/60">
                  <div className="flex-1 border-t border-border/40" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="uppercase tracking-wider font-semibold shrink-0 text-muted-foreground/50 flex items-center gap-1.5">
                        <Waves className="h-3 w-3" />
                        Wave {wave.wave}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Beads in this wave can run in parallel</TooltipContent>
                  </Tooltip>
                  <div className="flex-1 border-t border-border/40" />
                </div>
                {wave.beads.map(renderBeadRow)}
              </div>
            ))
          : beads.map(renderBeadRow)}
      </div>
    </div>
  )
}
