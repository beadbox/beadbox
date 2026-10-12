// beadbox-2wi: renders the Grouped (by status) arrangement built by
// groupTreeByStatus (pm/spec.md §4.2.4). Each status group shows the SAME epic
// card as the tree (EpicRow), listing only that group's rows, then the group's
// loose beads. Rows carry no children, so nothing is listed twice and no group
// shows a bead of another status.
import { BeadTable } from "@/components/bead-table"
import { EpicRow, type EpicRowProps } from "@/components/epic-tree"
import type { GroupedSection } from "@/lib/grouped-layout"

export type GroupedStatusViewProps = Omit<
  EpicRowProps,
  "epic" | "depth" | "focusKey" | "groupedRows" | "onToggle" | "expandedEpics"
> & {
  sections: GroupedSection[]
  expandedEpics: Set<string>
  onToggleEpic: (epicId: string) => void
}

export function GroupedStatusView({ sections, expandedEpics, onToggleEpic, ...card }: GroupedStatusViewProps) {
  return (
    <>
      {sections.map((section) => (
        <div key={section.status} data-group-status={section.status} className="space-y-1">
          <div className="px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {section.label} <span className="font-normal">({section.count})</span>
          </div>
          {section.cards.length > 0 && (
            <div className="space-y-3">
              {section.cards.map((c) => (
                <EpicRow
                  key={c.key}
                  {...card}
                  epic={c.epic}
                  depth={0}
                  focusKey={c.key}
                  groupedRows={c.beads}
                  expandedEpics={expandedEpics}
                  onToggle={onToggleEpic}
                />
              ))}
            </div>
          )}
          {section.loose.length > 0 && (
            <BeadTable
              beads={section.loose}
              epicId={`_grouped_${section.status}`}
              onBeadClick={card.onBeadClick}
              onArchive={card.onArchiveBead}
              onDelete={card.onRequestDelete}
              expandedBeads={card.expandedBeads}
              onToggleBead={card.onToggleBead}
              focusedItemId={card.focusedItemId}
              onFocusItem={card.onFocusItem}
              onDragStart={card.onDragStart}
              onDragEnd={card.onDragEnd}
              draggedBeadId={card.draggedBeadId}
              selectedBeadId={card.selectedBeadId}
              showWaves={card.showWaves}
              readState={card.readState}
              selectedIds={card.selectedIds}
              onToggleSelect={card.onToggleSelect}
              onToggleSelectAll={card.onToggleSelectAll}
            />
          )}
        </div>
      ))}
    </>
  )
}
