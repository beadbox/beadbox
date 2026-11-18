import { ChevronDown, ChevronRight } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { computeMoleculePhases } from "../lib/molecule-phases"
import type { Bead, ReadState } from "../lib/types"
import { cn } from "../lib/utils"
import { BeadTable } from "./bead-table"

interface MoleculePhaseViewProps {
  beads: Bead[]
  epicId: string
  onBeadClick: (bead: Bead) => void
  onArchive?: (beadId: string) => Promise<void>
  onDelete?: (beadId: string) => void
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
  // bb-y729: bulk-select pass-through
  selectedIds?: Set<string>
  onToggleSelect?: (beadId: string) => void
  onToggleSelectAll?: (visibleIds: string[]) => void
}

export function MoleculePhaseView({
  beads,
  epicId,
  onBeadClick,
  onArchive,
  onDelete,
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
}: MoleculePhaseViewProps) {
  const phases = useMemo(() => computeMoleculePhases(beads), [beads])

  const [collapsedPhases, setCollapsedPhases] = useState<Set<number>>(() => {
    const collapsed = new Set<number>()
    for (const phase of phases) {
      if (phase.closedCount === phase.totalCount && phase.totalCount > 0) {
        collapsed.add(phase.phaseNumber)
      }
    }
    return collapsed
  })

  // Auto-collapse phases that become fully complete via real-time update
  useEffect(() => {
    setCollapsedPhases((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const phase of phases) {
        const allComplete = phase.closedCount === phase.totalCount && phase.totalCount > 0
        if (allComplete && !next.has(phase.phaseNumber)) {
          next.add(phase.phaseNumber)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [phases])

  const togglePhase = (phaseNumber: number) => {
    setCollapsedPhases((prev) => {
      const next = new Set(prev)
      if (next.has(phaseNumber)) {
        next.delete(phaseNumber)
      } else {
        next.add(phaseNumber)
      }
      return next
    })
  }

  if (phases.length === 0) return null

  return (
    <div className="space-y-0">
      {phases.map((phase) => {
        const isCollapsed = collapsedPhases.has(phase.phaseNumber)
        const allComplete = phase.closedCount === phase.totalCount && phase.totalCount > 0

        return (
          <div key={phase.phaseNumber}>
            <button
              type="button"
              onClick={() => togglePhase(phase.phaseNumber)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors",
                "bg-white/[0.02] hover:bg-white/[0.05] border-b border-border/20",
                allComplete ? "text-muted-foreground/50" : "text-muted-foreground",
              )}
            >
              {isCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="uppercase tracking-wider font-medium">
                Phase {phase.phaseNumber}
              </span>
              <span
                className={cn(
                  "ml-auto font-mono tabular-nums",
                  allComplete ? "text-success-text/60" : "text-muted-foreground/60",
                )}
              >
                {phase.closedCount}/{phase.totalCount}
              </span>
            </button>

            {!isCollapsed && (
              <BeadTable
                beads={phase.tasks}
                epicId={epicId}
                onBeadClick={onBeadClick}
                onArchive={onArchive}
                onDelete={onDelete}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                draggedBeadId={draggedBeadId}
                expandedBeads={expandedBeads}
                onToggleBead={onToggleBead}
                focusedItemId={focusedItemId}
                onFocusItem={onFocusItem}
                selectedBeadId={selectedBeadId}
                showWaves={showWaves}
                readState={readState}
                selectedIds={selectedIds}
                onToggleSelect={onToggleSelect}
                onToggleSelectAll={onToggleSelectAll}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
