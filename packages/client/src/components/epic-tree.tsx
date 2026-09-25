"use client"

import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Flag,
  Hexagon,
  Inbox,
  Layers,
  RotateCcw,
  Trash2,
  Truck,
} from "lucide-react"
import { useMemo, useState } from "react"
import { BeadTable } from "@/components/bead-table"
import { CopyableId } from "@/components/copyable-id"
import { MoleculePhaseView } from "@/components/molecule-phase-view"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useViewport } from "@/hooks/use-viewport"
import { getStatusConfig, PillBadge, priorityConfig } from "@/lib/badge-config"
import { isMoleculePresentation } from "@/lib/molecule-presentation"
import type { Bead, Epic, ReadState } from "@/lib/types"
import { cn } from "@/lib/utils"

interface EpicTreeProps {
  epics: Epic[]
  milestones?: Epic[]
  convoys?: Epic[]
  molecules?: Epic[]
  archivedEpics?: Epic[]
  archivedBeads?: Bead[]
  backlogEpics?: Epic[]
  backlogBeads?: Bead[]
  expandedEpics: Set<string>
  onToggleEpic: (epicId: string) => void
  onSetExpandedEpics?: (epicIds: string[]) => void
  onBeadClick: (bead: Bead) => void
  onDelete?: (beadId: string) => void
  onBeadMove?: (beadId: string, targetEpicId: string, demoteToTask?: boolean) => void
  canMoveEpic?: (epicId: string, targetEpicId: string) => boolean
  dragOverEpicId?: string | null
  onDragOver?: (epicId: string | null) => void
  onDragStart?: (beadId: string) => void
  onDragEnd?: () => void
  draggedBeadId?: string | null
  expandedBeads?: Set<string>
  onToggleBead?: (beadId: string) => void
  focusedItemId?: string | null
  onFocusItem?: (id: string | null) => void
  onArchive?: (id: string, archived: boolean) => void
  onBacklog?: (id: string, inBacklog: boolean) => void
  selectedBeadId?: string | null
  showWaves?: boolean
  readState?: ReadState
  // bb-y729: page-level bulk-select pass-through to inner BeadTables
  selectedIds?: Set<string>
  onToggleSelect?: (beadId: string) => void
  onToggleSelectAll?: (visibleIds: string[]) => void
}

// Depth-based left border colors
import { getAggregatedCounts } from "@/lib/epic-progress"

const depthBorderColors = [
  "border-l-emerald-500",
  "border-l-teal-500",
  "border-l-cyan-500",
  "border-l-sky-500",
  "border-l-blue-500",
]

// Recursively collect all epic IDs from the tree (excluding _standalone)
function collectAllEpicIds(epics: Epic[]): string[] {
  const ids: string[] = []
  for (const epic of epics) {
    if (epic.id !== "_standalone") {
      ids.push(epic.id)
    }
    if (epic.childEpics && epic.childEpics.length > 0) {
      ids.push(...collectAllEpicIds(epic.childEpics))
    }
  }
  return ids
}

export function EpicTree({
  epics,
  milestones = [],
  convoys = [],
  molecules = [],
  archivedEpics = [],
  archivedBeads = [],
  backlogEpics = [],
  backlogBeads = [],
  expandedEpics,
  onToggleEpic,
  onSetExpandedEpics,
  onBeadClick,
  onDelete,
  onBeadMove,
  canMoveEpic,
  dragOverEpicId,
  onDragOver,
  onDragStart,
  onDragEnd,
  draggedBeadId,
  expandedBeads,
  onToggleBead,
  focusedItemId,
  onFocusItem,
  onArchive,
  onBacklog,
  selectedBeadId,
  showWaves,
  readState,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: EpicTreeProps) {
  const { isMobile } = useViewport()
  const [isDraggingToArchive, setIsDraggingToArchive] = useState(false)
  const [isDraggingToUnarchive, setIsDraggingToUnarchive] = useState(false)
  const [isDraggingToBacklog, setIsDraggingToBacklog] = useState(false)
  const [isDraggingFromBacklog, setIsDraggingFromBacklog] = useState(false)
  const [isDraggingToBacklogSection, setIsDraggingToBacklogSection] = useState(false)
  const [isDraggingToArchiveSection, setIsDraggingToArchiveSection] = useState(false)
  const [isEpicsExpanded, setIsEpicsExpanded] = useState(true)
  const [isMilestonesExpanded, setIsMilestonesExpanded] = useState(true)
  const [isMoleculesExpanded, setIsMoleculesExpanded] = useState(true)
  const [isConvoysExpanded, setIsConvoysExpanded] = useState(true)
  const [isBacklogExpanded, setIsBacklogExpanded] = useState(false)
  const [isArchiveExpanded, setIsArchiveExpanded] = useState(false)

  // Wrapper: converts EpicTree's onArchive(id, bool) to BeadTable's onArchive(id) => Promise
  const archiveBeadHandler = useMemo(
    () =>
      onArchive
        ? async (beadId: string) => {
            await onArchive(beadId, true)
          }
        : undefined,
    [onArchive],
  )

  // Helper to check if an ID exists anywhere in a bead tree (including subtasks)
  const isInBeadTree = (id: string, beads: Bead[]): boolean => {
    for (const bead of beads) {
      if (bead.id === id) return true
      if (bead.children && isInBeadTree(id, bead.children)) return true
    }
    return false
  }

  // Helper to check if an ID exists anywhere in an epic tree
  const isInEpicTree = (id: string, epicList: Epic[]): boolean => {
    for (const epic of epicList) {
      if (epic.id === id) return true
      if (epic.children && isInBeadTree(id, epic.children)) return true
      if (epic.childEpics && isInEpicTree(id, epic.childEpics)) return true
    }
    return false
  }

  // Find an epic by ID across all trees
  const findEpicById = (id: string, epicList: Epic[]): Epic | null => {
    for (const epic of epicList) {
      if (epic.id === id) return epic
      if (epic.childEpics) {
        const found = findEpicById(id, epic.childEpics)
        if (found) return found
      }
    }
    return null
  }

  const draggedEpic = draggedBeadId
    ? [epics, milestones, molecules, convoys, backlogEpics, archivedEpics]
        .map((group) => findEpicById(draggedBeadId, group))
        .find((epic) => epic !== null)
    : null
  const isBacklogItem = Boolean(
    draggedBeadId &&
      (draggedEpic?.priority === "backlog" ||
        isInEpicTree(draggedBeadId, backlogEpics) ||
        isInBeadTree(draggedBeadId, backlogBeads)),
  )
  const isArchivedItem = Boolean(
    draggedBeadId &&
      (draggedEpic?.labels?.includes("archived") ||
        isInEpicTree(draggedBeadId, archivedEpics) ||
        isInBeadTree(draggedBeadId, archivedBeads)),
  )

  const epicHasChildren = (id: string): boolean => {
    const epic =
      findEpicById(id, epics) ||
      findEpicById(id, milestones) ||
      findEpicById(id, molecules) ||
      findEpicById(id, convoys) ||
      findEpicById(id, archivedEpics) ||
      findEpicById(id, backlogEpics)
    if (!epic) return false
    return (epic.children?.length ?? 0) > 0 || (epic.childEpics?.length ?? 0) > 0
  }

  const draggedMilestone = Boolean(
    draggedBeadId &&
      [epics, milestones, molecules, convoys, archivedEpics, backlogEpics].some(
        (group) => findEpicById(draggedBeadId, group)?.type === "milestone",
      ),
  )

  // Count only actual epics (not _standalone)
  const epicCount = epics.filter((e) => e.id !== "_standalone").length
  const standaloneEpic = epics.find((e) => e.id === "_standalone")

  const milestoneCount = milestones.length
  const allMilestoneIds = collectAllEpicIds(milestones)
  const allMilestonesExpanded =
    allMilestoneIds.length > 0 && allMilestoneIds.every((id) => expandedEpics.has(id))

  // Expand/collapse all logic for epics
  const allEpicIds = collectAllEpicIds(epics)
  const allExpanded = allEpicIds.length > 0 && allEpicIds.every((id) => expandedEpics.has(id))

  // Expand/collapse all logic for molecules
  const moleculeCount = molecules.length
  const allMoleculeIds = collectAllEpicIds(molecules)
  const allMoleculesExpanded =
    allMoleculeIds.length > 0 && allMoleculeIds.every((id) => expandedEpics.has(id))

  // Expand/collapse all logic for convoys
  const convoyCount = convoys.length
  const allConvoyIds = collectAllEpicIds(convoys)
  const allConvoysExpanded =
    allConvoyIds.length > 0 && allConvoyIds.every((id) => expandedEpics.has(id))

  return (
    <div className="space-y-1 epic-tree-container">
      {milestoneCount > 0 && (
        <>
          <div className="flex items-center bg-muted/10">
            <button
              type="button"
              onClick={() => setIsMilestonesExpanded(!isMilestonesExpanded)}
              className={cn(
                "flex-1 flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors",
                isMobile && "min-h-[44px]",
              )}
            >
              {isMilestonesExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <Flag className="h-3.5 w-3.5" />
              <span className="uppercase tracking-wide font-medium">Milestones</span>
              <span className="text-muted-foreground/60">({milestoneCount})</span>
            </button>
            {isMilestonesExpanded && onSetExpandedEpics && allMilestoneIds.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (allMilestonesExpanded) {
                        onSetExpandedEpics(
                          Array.from(expandedEpics).filter((id) => !allMilestoneIds.includes(id)),
                        )
                      } else {
                        onSetExpandedEpics([...Array.from(expandedEpics), ...allMilestoneIds])
                      }
                    }}
                    className={cn(
                      "p-1.5 mr-1 text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-white/[0.07]",
                      isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                    )}
                  >
                    {allMilestonesExpanded ? (
                      <ChevronsDownUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {allMilestonesExpanded ? "Collapse all milestones" : "Expand all milestones"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {isMilestonesExpanded && (
            <div className="space-y-3 mt-1">
              {milestones.map((milestone) => (
                <EpicRow
                  key={milestone.id}
                  epic={milestone}
                  depth={0}
                  expandedEpics={expandedEpics}
                  onToggle={onToggleEpic}
                  onBeadClick={onBeadClick}
                  onRequestDelete={onDelete}
                  onArchiveBead={archiveBeadHandler}
                  onArchiveEpic={onArchive}
                  onBacklogEpic={onBacklog}
                  onBeadMove={onBeadMove}
                  canMoveEpic={canMoveEpic}
                  dragOverEpicId={dragOverEpicId}
                  onDragOver={onDragOver}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  draggedBeadId={draggedBeadId}
                  expandedBeads={expandedBeads}
                  onToggleBead={onToggleBead}
                  focusedItemId={focusedItemId}
                  onFocusItem={onFocusItem}
                  selectedBeadId={selectedBeadId}
                  showWaves={showWaves}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onToggleSelectAll={onToggleSelectAll}
                  isMobile={isMobile}
                  readState={readState}
                />
              ))}
            </div>
          )}
        </>
      )}
      {/* Epics section header */}
      {epicCount > 0 && (
        <>
          <div className="flex items-center bg-muted/10">
            <button
              type="button"
              onClick={() => setIsEpicsExpanded(!isEpicsExpanded)}
              className={cn(
                "flex-1 flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors",
                isMobile && "min-h-[44px]",
              )}
            >
              {isEpicsExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <Layers className="h-3.5 w-3.5" />
              <span className="uppercase tracking-wide font-medium">Epics</span>
              <span className="text-muted-foreground/60">({epicCount})</span>
            </button>
            {isEpicsExpanded && onSetExpandedEpics && allEpicIds.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSetExpandedEpics(allExpanded ? [] : allEpicIds)
                    }}
                    className={cn(
                      "p-1.5 mr-1 text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-white/[0.07]",
                      isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                    )}
                  >
                    {allExpanded ? (
                      <ChevronsDownUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {allExpanded ? "Collapse all epics" : "Expand all epics"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {isEpicsExpanded && (
            <div className="space-y-3 mt-1">
              {epics
                .filter((e) => e.id !== "_standalone")
                .map((epic, index) => (
                  <EpicRow
                    key={`${epic.id}-${index}`}
                    epic={epic}
                    depth={0}
                    expandedEpics={expandedEpics}
                    onToggle={onToggleEpic}
                    onBeadClick={onBeadClick}
                    onRequestDelete={onDelete}
                    onArchiveBead={archiveBeadHandler}
                    onArchiveEpic={onArchive}
                    onBacklogEpic={onBacklog}
                    onBeadMove={onBeadMove}
                    canMoveEpic={canMoveEpic}
                    dragOverEpicId={dragOverEpicId}
                    onDragOver={onDragOver}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    draggedBeadId={draggedBeadId}
                    expandedBeads={expandedBeads}
                    onToggleBead={onToggleBead}
                    focusedItemId={focusedItemId}
                    onFocusItem={onFocusItem}
                    selectedBeadId={selectedBeadId}
                    showWaves={showWaves}
                    selectedIds={selectedIds}
                    onToggleSelect={onToggleSelect}
                    onToggleSelectAll={onToggleSelectAll}
                    isMobile={isMobile}
                    readState={readState}
                  />
                ))}
            </div>
          )}
        </>
      )}

      {/* Standalone beads (rendered via EpicRow which handles the minimal header) */}
      {standaloneEpic && (
        <EpicRow
          key="_standalone"
          epic={standaloneEpic}
          depth={0}
          expandedEpics={expandedEpics}
          onToggle={onToggleEpic}
          onBeadClick={onBeadClick}
          onRequestDelete={onDelete}
          onArchiveBead={archiveBeadHandler}
          onArchiveEpic={onArchive}
          onBacklogEpic={onBacklog}
          onBeadMove={onBeadMove}
          canMoveEpic={canMoveEpic}
          dragOverEpicId={dragOverEpicId}
          onDragOver={onDragOver}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          draggedBeadId={draggedBeadId}
          expandedBeads={expandedBeads}
          onToggleBead={onToggleBead}
          focusedItemId={focusedItemId}
          onFocusItem={onFocusItem}
          selectedBeadId={selectedBeadId}
          showWaves={showWaves}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onToggleSelectAll={onToggleSelectAll}
          isMobile={isMobile}
          readState={readState}
        />
      )}

      {/* Molecules section */}
      {moleculeCount > 0 && (
        <>
          <div className="flex items-center bg-muted/10">
            <button
              type="button"
              onClick={() => setIsMoleculesExpanded(!isMoleculesExpanded)}
              className={cn(
                "flex-1 flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors",
                isMobile && "min-h-[44px]",
              )}
            >
              {isMoleculesExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <Hexagon className="h-3.5 w-3.5" />
              <span className="uppercase tracking-wide font-medium">Molecules</span>
              <span className="text-muted-foreground/60">({moleculeCount})</span>
            </button>
            {isMoleculesExpanded && onSetExpandedEpics && allMoleculeIds.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (allMoleculesExpanded) {
                        onSetExpandedEpics(
                          Array.from(expandedEpics).filter((id) => !allMoleculeIds.includes(id)),
                        )
                      } else {
                        onSetExpandedEpics([...Array.from(expandedEpics), ...allMoleculeIds])
                      }
                    }}
                    className={cn(
                      "p-1.5 mr-1 text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-white/[0.07]",
                      isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                    )}
                  >
                    {allMoleculesExpanded ? (
                      <ChevronsDownUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {allMoleculesExpanded ? "Collapse all molecules" : "Expand all molecules"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {isMoleculesExpanded && (
            <div className="space-y-3 mt-1">
              {molecules.map((molecule, index) => (
                <EpicRow
                  key={`molecule-${molecule.id}-${index}`}
                  epic={molecule}
                  depth={0}
                  expandedEpics={expandedEpics}
                  onToggle={onToggleEpic}
                  onBeadClick={onBeadClick}
                  onRequestDelete={onDelete}
                  onArchiveBead={archiveBeadHandler}
                  onArchiveEpic={onArchive}
                  onBacklogEpic={onBacklog}
                  onBeadMove={onBeadMove}
                  canMoveEpic={canMoveEpic}
                  dragOverEpicId={dragOverEpicId}
                  onDragOver={onDragOver}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  draggedBeadId={draggedBeadId}
                  expandedBeads={expandedBeads}
                  onToggleBead={onToggleBead}
                  focusedItemId={focusedItemId}
                  onFocusItem={onFocusItem}
                  selectedBeadId={selectedBeadId}
                  showWaves={showWaves}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onToggleSelectAll={onToggleSelectAll}
                  isMobile={isMobile}
                  readState={readState}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Convoys section */}
      {convoyCount > 0 && (
        <>
          <div className="flex items-center bg-muted/10">
            <button
              type="button"
              onClick={() => setIsConvoysExpanded(!isConvoysExpanded)}
              className={cn(
                "flex-1 flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors",
                isMobile && "min-h-[44px]",
              )}
            >
              {isConvoysExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <Truck className="h-3.5 w-3.5" />
              <span className="uppercase tracking-wide font-medium">Convoys</span>
              <span className="text-muted-foreground/60">({convoyCount})</span>
            </button>
            {isConvoysExpanded && onSetExpandedEpics && allConvoyIds.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      // Merge convoy expand/collapse with existing epic expansions
                      if (allConvoysExpanded) {
                        onSetExpandedEpics(
                          Array.from(expandedEpics).filter((id) => !allConvoyIds.includes(id)),
                        )
                      } else {
                        onSetExpandedEpics([...Array.from(expandedEpics), ...allConvoyIds])
                      }
                    }}
                    className={cn(
                      "p-1.5 mr-1 text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-white/[0.07]",
                      isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                    )}
                  >
                    {allConvoysExpanded ? (
                      <ChevronsDownUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {allConvoysExpanded ? "Collapse all convoys" : "Expand all convoys"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {isConvoysExpanded && (
            <div className="space-y-3 mt-1">
              {convoys.map((convoy, index) => (
                <EpicRow
                  key={`convoy-${convoy.id}-${index}`}
                  epic={convoy}
                  depth={0}
                  expandedEpics={expandedEpics}
                  onToggle={onToggleEpic}
                  onBeadClick={onBeadClick}
                  onRequestDelete={onDelete}
                  onArchiveBead={archiveBeadHandler}
                  onArchiveEpic={onArchive}
                  onBacklogEpic={onBacklog}
                  onBeadMove={onBeadMove}
                  canMoveEpic={canMoveEpic}
                  dragOverEpicId={dragOverEpicId}
                  onDragOver={onDragOver}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  draggedBeadId={draggedBeadId}
                  expandedBeads={expandedBeads}
                  onToggleBead={onToggleBead}
                  focusedItemId={focusedItemId}
                  onFocusItem={onFocusItem}
                  selectedBeadId={selectedBeadId}
                  showWaves={showWaves}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onToggleSelectAll={onToggleSelectAll}
                  isMobile={isMobile}
                  readState={readState}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Archive drop zone - hide when dragging from archive */}
      {draggedBeadId && onArchive && !isArchivedItem && (
        <div
          className={cn(
            "border-2 border-dashed rounded-lg p-4 transition-colors",
            isDraggingToArchive ? "border-amber-500 bg-amber-500/10" : "border-muted-foreground/30",
          )}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            setIsDraggingToArchive(true)
          }}
          onDragLeave={() => setIsDraggingToArchive(false)}
          onDrop={(e) => {
            e.preventDefault()
            try {
              const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
              if (data.beadId) {
                onArchive(data.beadId, true)
              }
            } catch {
              // Invalid drag data
            }
            setIsDraggingToArchive(false)
          }}
        >
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <Archive className="h-4 w-4" />
            <span className="text-sm">Drop here to archive</span>
          </div>
        </div>
      )}

      {/* Backlog drop zone - hide when dragging from backlog or archive */}
      {draggedBeadId && onBacklog && !isBacklogItem && !isArchivedItem && (
        <div
          className={cn(
            "mt-2 border-2 border-dashed rounded-lg p-4 transition-colors",
            isDraggingToBacklog ? "border-blue-500 bg-blue-500/10" : "border-muted-foreground/30",
          )}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            setIsDraggingToBacklog(true)
          }}
          onDragLeave={() => setIsDraggingToBacklog(false)}
          onDrop={(e) => {
            e.preventDefault()
            try {
              const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
              if (data.beadId) {
                onBacklog(data.beadId, true)
              }
            } catch {
              // Invalid drag data
            }
            setIsDraggingToBacklog(false)
          }}
        >
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <Inbox className="h-4 w-4" />
            <span className="text-sm">Drop here to move to backlog</span>
          </div>
        </div>
      )}

      {/* Make top-level epic / Make loose bead - side by side */}
      {draggedBeadId && (
        <div className="mt-2 flex gap-2">
          <div
            className={cn(
              "flex-1 border-2 border-dashed rounded-lg p-3 text-center text-sm text-muted-foreground transition-colors",
              dragOverEpicId === "_toplevel"
                ? "border-emerald-500 bg-emerald-500/10"
                : "border-border",
            )}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = "move"
              onDragOver?.("_toplevel")
            }}
            onDragLeave={() => onDragOver?.(null)}
            onDrop={(e) => {
              e.preventDefault()
              try {
                const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
                onBeadMove?.(data.beadId, "_toplevel")
              } catch {
                // Invalid drag data
              }
              onDragOver?.(null)
            }}
          >
            {draggedMilestone ? "Make top-level milestone" : "Make top-level epic"}
          </div>
          <div
            className={cn(
              "flex-1 border-2 border-dashed rounded-lg p-3 text-center text-sm text-muted-foreground transition-colors",
              draggedMilestone && "opacity-50",
              dragOverEpicId === "_loose" ? "border-blue-500 bg-blue-500/10" : "border-border",
            )}
            aria-disabled={draggedMilestone}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = draggedMilestone ? "none" : "move"
              if (!draggedMilestone) onDragOver?.("_loose")
            }}
            onDragLeave={() => onDragOver?.(null)}
            onDrop={(e) => {
              e.preventDefault()
              try {
                const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
                if (data.type === "milestone") return
                if (data.type === "epic" && epicHasChildren(data.beadId)) {
                  // Epic with children can't become a loose bead
                  return
                }
                onBeadMove?.(data.beadId, "_standalone", data.type === "epic")
              } catch {
                // Invalid drag data
              }
              onDragOver?.(null)
            }}
          >
            {draggedMilestone ? "Milestones cannot be loose" : "Make loose bead"}
          </div>
        </div>
      )}

      {/* Backlog section */}
      {(backlogEpics.length > 0 || backlogBeads.length > 0) && (
        <div
          className={cn(
            "mt-6 rounded-lg transition-colors",
            draggedBeadId &&
              !isBacklogItem &&
              !isArchivedItem &&
              isDraggingToBacklogSection &&
              "ring-2 ring-blue-500/50 bg-blue-500/5",
          )}
          onDragOver={
            draggedBeadId && onBacklog && !isBacklogItem && !isArchivedItem
              ? (e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = "move"
                  setIsDraggingToBacklogSection(true)
                }
              : undefined
          }
          onDragLeave={
            draggedBeadId
              ? (e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setIsDraggingToBacklogSection(false)
                  }
                }
              : undefined
          }
          onDrop={
            draggedBeadId && onBacklog && !isBacklogItem && !isArchivedItem
              ? (e) => {
                  e.preventDefault()
                  try {
                    const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
                    if (data.beadId) {
                      onBacklog(data.beadId, true)
                    }
                  } catch {
                    // Invalid drag data
                  }
                  setIsDraggingToBacklogSection(false)
                }
              : undefined
          }
        >
          {/* Restore from backlog drop zone */}
          {draggedBeadId && onBacklog && isBacklogItem && (
            <div
              className={cn(
                "mb-4 border-2 border-dashed rounded-lg p-4 transition-colors",
                isDraggingFromBacklog
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-muted-foreground/30",
              )}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = "move"
                setIsDraggingFromBacklog(true)
              }}
              onDragLeave={() => setIsDraggingFromBacklog(false)}
              onDrop={(e) => {
                e.preventDefault()
                try {
                  const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
                  if (data.beadId) {
                    onBacklog(data.beadId, false)
                  }
                } catch {
                  // Invalid drag data
                }
                setIsDraggingFromBacklog(false)
              }}
            >
              <div className="flex items-center justify-center gap-2 text-emerald-500">
                <Inbox className="h-4 w-4" />
                <span className="text-sm font-medium">Drop here to restore from backlog</span>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => setIsBacklogExpanded(!isBacklogExpanded)}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-muted/10",
              isMobile && "min-h-[44px]",
            )}
          >
            {isBacklogExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            <Inbox className="h-3.5 w-3.5" />
            <span className="uppercase tracking-wide font-medium">Backlog</span>
            <span className="text-muted-foreground/60">
              ({backlogEpics.length + backlogBeads.length})
            </span>
          </button>

          {isBacklogExpanded && (
            <div className="space-y-3 mt-1 opacity-60">
              {/* Backlog epics */}
              {backlogEpics.map((epic, index) => (
                <EpicRow
                  key={`backlog-${epic.id}-${index}`}
                  epic={epic}
                  depth={0}
                  expandedEpics={expandedEpics}
                  onToggle={onToggleEpic}
                  onBeadClick={onBeadClick}
                  onRequestDelete={onDelete}
                  onArchiveBead={archiveBeadHandler}
                  onArchiveEpic={onArchive}
                  onBacklogEpic={onBacklog}
                  onBeadMove={onBeadMove}
                  canMoveEpic={canMoveEpic}
                  dragOverEpicId={dragOverEpicId}
                  onDragOver={onDragOver}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  draggedBeadId={draggedBeadId}
                  expandedBeads={expandedBeads}
                  onToggleBead={onToggleBead}
                  focusedItemId={focusedItemId}
                  onFocusItem={onFocusItem}
                  isBacklog
                  selectedBeadId={selectedBeadId}
                  showWaves={showWaves}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onToggleSelectAll={onToggleSelectAll}
                  isMobile={isMobile}
                  readState={readState}
                />
              ))}
              {/* Backlog loose beads */}
              {backlogBeads.length > 0 && (
                <div className="space-y-0.5">
                  <BeadTable
                    beads={backlogBeads}
                    onBeadClick={onBeadClick}
                    onArchive={archiveBeadHandler}
                    onDelete={onDelete}
                    epicId="_standalone"
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    draggedBeadId={draggedBeadId}
                    expandedBeads={expandedBeads}
                    onToggleBead={onToggleBead}
                    focusedItemId={focusedItemId}
                    onFocusItem={onFocusItem}
                    selectedBeadId={selectedBeadId}
                    showWaves={showWaves}
                    selectedIds={selectedIds}
                    onToggleSelect={onToggleSelect}
                    onToggleSelectAll={onToggleSelectAll}
                    readState={readState}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Archived section (epics + loose beads) */}
      {(archivedEpics.length > 0 || archivedBeads.length > 0) && (
        <div
          className={cn(
            "mt-6 rounded-lg transition-colors",
            draggedBeadId &&
              !isArchivedItem &&
              isDraggingToArchiveSection &&
              "ring-2 ring-amber-500/50 bg-amber-500/5",
          )}
          onDragOver={
            draggedBeadId && onArchive && !isArchivedItem
              ? (e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = "move"
                  setIsDraggingToArchiveSection(true)
                }
              : undefined
          }
          onDragLeave={
            draggedBeadId
              ? (e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setIsDraggingToArchiveSection(false)
                  }
                }
              : undefined
          }
          onDrop={
            draggedBeadId && onArchive && !isArchivedItem
              ? (e) => {
                  e.preventDefault()
                  try {
                    const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
                    if (data.beadId) {
                      onArchive(data.beadId, true)
                    }
                  } catch {
                    // Invalid drag data
                  }
                  setIsDraggingToArchiveSection(false)
                }
              : undefined
          }
        >
          {/* Restore from archive drop zone */}
          {draggedBeadId && onArchive && isArchivedItem && (
            <div
              className={cn(
                "mb-4 border-2 border-dashed rounded-lg p-4 transition-colors",
                isDraggingToUnarchive
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-muted-foreground/30",
              )}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = "move"
                setIsDraggingToUnarchive(true)
              }}
              onDragLeave={() => setIsDraggingToUnarchive(false)}
              onDrop={(e) => {
                e.preventDefault()
                try {
                  const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
                  if (data.beadId) {
                    onArchive(data.beadId, false)
                  }
                } catch {
                  // Invalid drag data
                }
                setIsDraggingToUnarchive(false)
              }}
            >
              <div className="flex items-center justify-center gap-2 text-emerald-500">
                <Archive className="h-4 w-4" />
                <span className="text-sm font-medium">Drop here to restore from archive</span>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => setIsArchiveExpanded(!isArchiveExpanded)}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-muted/10",
              isMobile && "min-h-[44px]",
            )}
          >
            {isArchiveExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            <Archive className="h-3.5 w-3.5" />
            <span className="uppercase tracking-wide font-medium">Archived</span>
            <span className="text-muted-foreground/60">
              ({archivedEpics.length + archivedBeads.length})
            </span>
          </button>

          {isArchiveExpanded && (
            <div className="space-y-3 mt-1 opacity-50">
              {/* Archived epics */}
              {archivedEpics.map((epic, index) => (
                <EpicRow
                  key={`archived-${epic.id}-${index}`}
                  epic={epic}
                  depth={0}
                  expandedEpics={expandedEpics}
                  onToggle={onToggleEpic}
                  onBeadClick={onBeadClick}
                  onRequestDelete={onDelete}
                  onArchiveBead={archiveBeadHandler}
                  onArchiveEpic={onArchive}
                  onBacklogEpic={onBacklog}
                  onBeadMove={onBeadMove}
                  canMoveEpic={canMoveEpic}
                  dragOverEpicId={dragOverEpicId}
                  onDragOver={onDragOver}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  draggedBeadId={draggedBeadId}
                  expandedBeads={expandedBeads}
                  onToggleBead={onToggleBead}
                  focusedItemId={focusedItemId}
                  onFocusItem={onFocusItem}
                  isArchived
                  selectedBeadId={selectedBeadId}
                  showWaves={showWaves}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onToggleSelectAll={onToggleSelectAll}
                  isMobile={isMobile}
                  readState={readState}
                />
              ))}
              {/* Archived loose beads */}
              {archivedBeads.length > 0 && (
                <div className="space-y-0.5">
                  <BeadTable
                    beads={archivedBeads}
                    onBeadClick={onBeadClick}
                    onArchive={archiveBeadHandler}
                    onDelete={onDelete}
                    epicId="_standalone"
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    draggedBeadId={draggedBeadId}
                    expandedBeads={expandedBeads}
                    onToggleBead={onToggleBead}
                    focusedItemId={focusedItemId}
                    onFocusItem={onFocusItem}
                    selectedBeadId={selectedBeadId}
                    showWaves={showWaves}
                    selectedIds={selectedIds}
                    onToggleSelect={onToggleSelect}
                    onToggleSelectAll={onToggleSelectAll}
                    readState={readState}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface EpicRowProps {
  epic: Epic
  depth: number
  expandedEpics: Set<string>
  onToggle: (epicId: string) => void
  onBeadClick: (bead: Bead) => void
  onRequestDelete?: (beadId: string) => void
  onArchiveBead?: (beadId: string) => Promise<void>
  // beadbox-7xr: epic-row archive callback per pm/spec.md §4.2. Reuses
  // the same (id, archived) shape as the drag-to-archive drop zone above,
  // so the server-confirmed re-render pattern from §4.2.2 is inherited
  // without a new IPC method.
  onArchiveEpic?: (id: string, archived: boolean) => void
  onBacklogEpic?: (id: string, inBacklog: boolean) => void
  onBeadMove?: (beadId: string, targetEpicId: string, demoteToTask?: boolean) => void
  canMoveEpic?: (epicId: string, targetEpicId: string) => boolean
  dragOverEpicId?: string | null
  onDragOver?: (epicId: string | null) => void
  onDragStart?: (beadId: string) => void
  onDragEnd?: () => void
  draggedBeadId?: string | null
  expandedBeads?: Set<string>
  onToggleBead?: (beadId: string) => void
  focusedItemId?: string | null
  onFocusItem?: (id: string | null) => void
  isArchived?: boolean
  isBacklog?: boolean
  selectedBeadId?: string | null
  showWaves?: boolean
  isMobile?: boolean
  readState?: ReadState
  selectedIds?: Set<string>
  onToggleSelect?: (beadId: string) => void
  onToggleSelectAll?: (visibleIds: string[]) => void
}

function getEpicRowState(
  epic: Epic,
  depth: number,
  isMobile: boolean,
  isArchived: boolean,
  isBacklog: boolean,
) {
  const hasChildEpics = epic.childEpics && epic.childEpics.length > 0
  const hasChildBeads = (epic.children?.length ?? 0) > 0
  const hasContent = hasChildEpics || hasChildBeads
  const isStandalone = epic.id === "_standalone"
  return {
    hasChildEpics,
    hasChildBeads,
    hasContent,
    isEmpty: !hasContent,
    depthMargin: isMobile ? Math.min(depth, 2) * 6 : depth * 12,
    isStandalone,
    rowArchived: isArchived || Boolean(epic.labels?.includes("archived")),
    rowBacklogged: isBacklog || epic.priority === "backlog",
    borderColor: isStandalone
      ? ""
      : depthBorderColors[Math.min(depth, depthBorderColors.length - 1)],
    isDraggable: !isStandalone,
  }
}

function EpicRow({
  epic,
  depth,
  expandedEpics,
  onToggle,
  onBeadClick,
  onRequestDelete,
  onArchiveBead,
  onArchiveEpic,
  onBacklogEpic,
  onBeadMove,
  canMoveEpic,
  dragOverEpicId,
  onDragOver,
  onDragStart,
  onDragEnd,
  draggedBeadId,
  expandedBeads,
  onToggleBead,
  focusedItemId,
  onFocusItem,
  isArchived = false,
  isBacklog = false,
  selectedBeadId,
  showWaves,
  isMobile = false,
  readState,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: EpicRowProps) {
  const isExpanded = expandedEpics.has(epic.id)
  const { closed: closedCount, total: totalCount } = getAggregatedCounts(epic)
  const progress = totalCount > 0 ? (closedCount / totalCount) * 100 : 0
  const {
    hasChildEpics,
    hasChildBeads,
    hasContent,
    isEmpty,
    depthMargin,
    isStandalone,
    rowArchived,
    rowBacklogged,
    borderColor,
    isDraggable,
  } = getEpicRowState(epic, depth, isMobile, isArchived, isBacklog)

  // Render standalone beads with a minimal header instead of a full card
  if (isStandalone) {
    return (
      <div data-item-id={epic.id} className="mt-4">
        <button
          type="button"
          onClick={() => onToggle(epic.id)}
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors bg-muted/10",
            isMobile && "min-h-[44px]",
          )}
        >
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="uppercase tracking-wide font-medium">Loose Beads</span>
          <span className="text-muted-foreground/60">({epic.children?.length || 0})</span>
        </button>

        {isExpanded && (
          <div
            className="mt-1 space-y-0.5"
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = "move"
              onDragOver?.("_standalone")
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                onDragOver?.(null)
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              try {
                const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
                onBeadMove?.(data.beadId, "_standalone")
              } catch {}
              onDragOver?.(null)
            }}
          >
            <BeadTable
              beads={epic.children ?? []}
              epicId="_standalone"
              onBeadClick={onBeadClick}
              onArchive={onArchiveBead}
              onDelete={onRequestDelete}
              expandedBeads={expandedBeads}
              onToggleBead={onToggleBead}
              focusedItemId={focusedItemId}
              onFocusItem={onFocusItem}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              draggedBeadId={draggedBeadId}
              selectedBeadId={selectedBeadId}
              showWaves={showWaves}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
              onToggleSelectAll={onToggleSelectAll}
              readState={readState}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      data-item-id={epic.id}
      className={cn(
        "overflow-hidden border-l-2",
        borderColor,
        focusedItemId === epic.id && "ring-1 ring-primary/60",
      )}
      style={{ marginLeft: depthMargin }}
    >
      <div
        draggable={isDraggable}
        className={cn(
          "w-full flex items-center bg-white/[0.04] hover:bg-white/[0.07] transition-colors select-none",
          isMobile ? "px-2 py-1.5 gap-2 min-h-[44px]" : "px-3 py-2.5 gap-3",
          isDraggable && "cursor-grab active:cursor-grabbing",
          dragOverEpicId === epic.id && "ring-1 ring-emerald-500 ring-inset bg-emerald-500/10",
          draggedBeadId === epic.id && "opacity-50",
          selectedBeadId === epic.id && "bg-primary/10",
        )}
        onDragStart={(e) => {
          if (isDraggable) {
            e.dataTransfer.setData(
              "application/x-bead-move",
              JSON.stringify({ beadId: epic.id, sourceEpicId: epic.parentId, type: epic.type }),
            )
            e.dataTransfer.effectAllowed = "move"
            onDragStart?.(epic.id)
          }
        }}
        onDragEnd={() => onDragEnd?.()}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = "move"
          onDragOver?.(epic.id)
        }}
        onDragLeave={(e) => {
          // Only clear if leaving the container entirely (not entering a child)
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            onDragOver?.(null)
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          try {
            const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
            if (data.sourceEpicId !== epic.id) {
              if (data.type === "epic" || data.type === "milestone") {
                // Validate epic move: can't drop on self or create cycles
                if (data.beadId === epic.id) return
                if (canMoveEpic && !canMoveEpic(data.beadId, epic.id)) return
              }
              onBeadMove?.(data.beadId, epic.id)
            }
          } catch {
            // Invalid drag data
          }
          onDragOver?.(null)
        }}
      >
        {/* Chevron button - expand/collapse only */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggle(epic.id)
          }}
          className={cn(
            "text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center",
            isMobile ? "min-w-[44px] min-h-[44px] -ml-2" : "",
          )}
        >
          {hasContent ? (
            isExpanded ? (
              <ChevronDown className="h-5 w-5" />
            ) : (
              <ChevronRight className="h-5 w-5" />
            )
          ) : (
            <div className="w-5" />
          )}
        </button>

        {/* Clickable row area for viewing epic details */}
        <div
          className={cn(
            "flex-1 flex items-center min-w-0 overflow-hidden",
            isMobile ? "gap-2" : "gap-3",
            !isStandalone && "cursor-pointer",
          )}
          onClick={() => {
            if (!isStandalone) {
              onFocusItem?.(epic.id)
              onBeadClick(epic)
            }
          }}
        >
          {!isStandalone && !isMobile && <CopyableId id={epic.id} className="w-28 shrink-0" />}

          {!isStandalone && epic.type === "convoy" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Truck className="h-3.5 w-3.5 text-lime-400 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Convoy</TooltipContent>
            </Tooltip>
          )}
          {!isStandalone && isMoleculePresentation(epic) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Hexagon className="h-3.5 w-3.5 text-pink-400 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Molecule</TooltipContent>
            </Tooltip>
          )}
          {!isStandalone && epic.type === "milestone" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Flag className="h-3.5 w-3.5 text-sky-400 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Milestone</TooltipContent>
            </Tooltip>
          )}
          {!isStandalone &&
            epic.type !== "convoy" &&
            epic.type !== "milestone" &&
            !isMoleculePresentation(epic) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Layers className="h-3.5 w-3.5 text-amber-400/60 shrink-0" />
                </TooltipTrigger>
                <TooltipContent>Epic</TooltipContent>
              </Tooltip>
            )}
          <span
            className={cn(
              "font-medium text-foreground/70 flex-1 truncate min-w-[80px]",
              isMobile && "text-sm",
            )}
          >
            {epic.title}
          </span>
        </div>

        {!isStandalone && (
          <>
            <PillBadge config={getStatusConfig(epic.status)} />
            <PillBadge config={priorityConfig[epic.priority]} />
          </>
        )}

        {onBacklogEpic && !isStandalone && rowBacklogged && !rowArchived && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Restore ${epic.type} from backlog: ${epic.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onBacklogEpic(epic.id, false)
                }}
                className="p-1.5 rounded hover:bg-blue-500/20 text-muted-foreground hover:text-blue-400 transition-colors"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Restore from backlog</TooltipContent>
          </Tooltip>
        )}

        {onArchiveEpic && !isStandalone && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                aria-label={`${rowArchived ? "Unarchive" : "Archive"} ${epic.type}: ${epic.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onArchiveEpic(epic.id, !rowArchived)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation()
                    e.preventDefault()
                    onArchiveEpic(epic.id, !rowArchived)
                  }
                }}
                className={cn(
                  "p-1.5 rounded hover:bg-amber-500/20 text-muted-foreground hover:text-amber-400 transition-colors cursor-pointer",
                  isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                )}
              >
                <Archive className="h-4 w-4" />
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {rowArchived ? "Unarchive" : "Archive"} {epic.type}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Delete button for empty root issues */}
        {onRequestDelete && isEmpty && !isStandalone && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  onRequestDelete(epic.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation()
                    e.preventDefault()
                    onRequestDelete(epic.id)
                  }
                }}
                className={cn(
                  "p-1.5 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors cursor-pointer",
                  isMobile && "min-h-[44px] min-w-[44px] flex items-center justify-center",
                )}
              >
                <Trash2 className="h-4 w-4" />
              </div>
            </TooltipTrigger>
            <TooltipContent>Delete empty {epic.type}</TooltipContent>
          </Tooltip>
        )}

        {/* Progress indicator: compact count on mobile, full bar on desktop */}
        {isMobile ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "text-xs font-mono shrink-0 tabular-nums",
                  closedCount === totalCount && totalCount > 0
                    ? "text-emerald-400"
                    : "text-muted-foreground",
                )}
              >
                {closedCount}/{totalCount}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {closedCount}/{totalCount} complete ({Math.round(progress)}%)
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-3 shrink-0">
                <div className="w-36 group">
                  <div className="relative h-3 bg-slate-700/60 rounded-full overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-600/80 via-emerald-500/70 to-teal-500/70 rounded-full transition-all duration-500 ease-out group-hover:brightness-110 group-hover:shadow-[0_0_8px_rgba(34,197,94,0.3)]"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
                <span
                  className={cn(
                    "text-sm font-mono min-w-[90px] text-right",
                    closedCount === totalCount && totalCount > 0
                      ? "text-emerald-400"
                      : "text-muted-foreground",
                  )}
                >
                  {closedCount}/{totalCount} ({Math.round(progress)}%)
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {closedCount}/{totalCount} complete
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {isExpanded && hasContent && (
        <div
          className={cn(
            "border-t border-border/30",
            dragOverEpicId === epic.id && "bg-emerald-500/5",
          )}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            onDragOver?.(epic.id)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              onDragOver?.(null)
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            try {
              const data = JSON.parse(e.dataTransfer.getData("application/x-bead-move"))
              if (data.sourceEpicId !== epic.id) {
                if (data.type === "epic" || data.type === "milestone") {
                  if (data.beadId === epic.id) return
                  if (canMoveEpic && !canMoveEpic(data.beadId, epic.id)) return
                }
                onBeadMove?.(data.beadId, epic.id)
              }
            } catch {
              // Invalid drag data
            }
            onDragOver?.(null)
          }}
        >
          {/* Render child epics first */}
          {hasChildEpics && (
            <div className="py-3 pr-3 space-y-3 bg-black/20">
              {epic.childEpics!.map((childEpic, index) => (
                <EpicRow
                  key={`${childEpic.id}-${depth}-${index}`}
                  epic={childEpic}
                  depth={depth + 1}
                  expandedEpics={expandedEpics}
                  onToggle={onToggle}
                  onBeadClick={onBeadClick}
                  onRequestDelete={onRequestDelete}
                  onArchiveBead={onArchiveBead}
                  onArchiveEpic={onArchiveEpic}
                  onBacklogEpic={onBacklogEpic}
                  onBeadMove={onBeadMove}
                  canMoveEpic={canMoveEpic}
                  dragOverEpicId={dragOverEpicId}
                  onDragOver={onDragOver}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  draggedBeadId={draggedBeadId}
                  expandedBeads={expandedBeads}
                  onToggleBead={onToggleBead}
                  focusedItemId={focusedItemId}
                  onFocusItem={onFocusItem}
                  selectedBeadId={selectedBeadId}
                  showWaves={showWaves}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onToggleSelectAll={onToggleSelectAll}
                  isMobile={isMobile}
                  readState={readState}
                />
              ))}
            </div>
          )}

          {/* Render child beads */}
          {hasChildBeads && (
            <div className={cn(hasChildEpics && "border-t border-border/30")}>
              {isMoleculePresentation(epic) ? (
                <MoleculePhaseView
                  beads={epic.children ?? []}
                  epicId={epic.id}
                  onBeadClick={onBeadClick}
                  onArchive={onArchiveBead}
                  onDelete={onRequestDelete}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  draggedBeadId={draggedBeadId}
                  expandedBeads={expandedBeads}
                  onToggleBead={onToggleBead}
                  focusedItemId={focusedItemId}
                  onFocusItem={onFocusItem}
                  selectedBeadId={selectedBeadId}
                  showWaves={showWaves}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onToggleSelectAll={onToggleSelectAll}
                  readState={readState}
                />
              ) : (
                <BeadTable
                  beads={epic.children ?? []}
                  onBeadClick={onBeadClick}
                  onArchive={onArchiveBead}
                  onDelete={onRequestDelete}
                  epicId={epic.id}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  draggedBeadId={draggedBeadId}
                  expandedBeads={expandedBeads}
                  onToggleBead={onToggleBead}
                  focusedItemId={focusedItemId}
                  onFocusItem={onFocusItem}
                  selectedBeadId={selectedBeadId}
                  showWaves={showWaves}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onToggleSelectAll={onToggleSelectAll}
                  readState={readState}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
