// Left-hand workspace rail — vertical project tabs.
//
// Presentational only: every piece of state (width, collapsed, active id,
// in-flight switch, which tab is being renamed) arrives as props or stays
// local to a tab, so the rail can be rendered bare in unit tests
// (packages/client/src/__tests__/workspace-rail.test.tsx). The container
// that owns rpc + persistence is workspace-rail-panel.tsx.

import {
  ArrowDown,
  ArrowUp,
  Circle,
  LayoutGrid,
  Loader2,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react"
import {
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import type { WorkspaceCard } from "../lib/types"
import { cn } from "../lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"
import { WorkspaceTabDialog } from "./workspace-tab-dialog"

/** Icon-only width used when the rail is collapsed. */
export const WORKSPACE_RAIL_COLLAPSED_WIDTH = 56

const ROW_BASE =
  "relative w-full flex items-center gap-2 rounded-md px-1.5 text-sm transition-colors"
const ROW_INACTIVE = "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
const ROW_ACTIVE = "bg-accent text-foreground"
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
// beadbox-984: drag payload type, so a bead (or a file) dragged over the rail
// is not taken for a workspace.
const WORKSPACE_DRAG_TYPE = "application/x-beadbox-workspace"
const REORDER_HINT_ID = "workspace-rail-reorder-hint"
// Two-line tab: 36px avatar inside py-1.5 → ~48px, twice a single-line row.
const AVATAR =
  "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/60 text-lg"

type DropEdge = "before" | "after"

interface WorkspaceRailItemProps {
  workspace: WorkspaceCard
  /** 0-based place in the list, and the list's length (for moves and the menu). */
  position: number
  count: number
  active: boolean
  collapsed: boolean
  busy: boolean
  /** This row is the one being dragged. */
  dragging: boolean
  /** Where a drop on this row would land, while a workspace is dragged over it. */
  dropEdge: DropEdge | null
  onDragStartItem: (workspace: WorkspaceCard) => void
  onDragEndItem: () => void
  onDragOverItem: (workspace: WorkspaceCard, edge: DropEdge) => void
  onDropOnItem: (workspace: WorkspaceCard, edge: DropEdge) => void
  /** Keyboard / menu move to an absolute position. */
  onMoveTo?: (workspace: WorkspaceCard, toIndex: number) => void
  onSelect: (workspace: WorkspaceCard) => void
  onRemove: (workspace: WorkspaceCard) => void
  onRelabel: (
    workspace: WorkspaceCard,
    label: { name?: string; icon?: string | null },
  ) => Promise<boolean>
}

function WorkspaceRailItem({
  workspace,
  position,
  count,
  active,
  collapsed,
  busy,
  dragging,
  dropEdge,
  onDragStartItem,
  onDragEndItem,
  onDragOverItem,
  onDropOnItem,
  onMoveTo,
  onSelect,
  onRemove,
  onRelabel,
}: WorkspaceRailItemProps) {
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(workspace.name)
  const [editOpen, setEditOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Renaming is committed on blur; Escape has to suppress that commit.
  const cancelledRef = useRef(false)

  const isServerOnly = workspace.path === null && !!workspace.serverHost
  const unavailable = workspace.available === false
  const subtitle = isServerOnly
    ? `${workspace.serverHost}:${workspace.serverPort} · ${workspace.serverDatabase}`
    : (workspace.path ?? workspace.databasePath)

  const startRename = useCallback(() => {
    setDraftName(workspace.name)
    cancelledRef.current = false
    setRenaming(true)
  }, [workspace.name])

  const commitRename = useCallback(() => {
    setRenaming(false)
    if (cancelledRef.current) return
    const next = draftName.trim()
    if (next.length === 0 || next === workspace.name) return
    void onRelabel(workspace, { name: next })
  }, [draftName, onRelabel, workspace])

  // beadbox-984: native HTML5 drag, the pattern bead rows use (bead-table.tsx).
  const dragProps = {
    draggable: !renaming && !!onMoveTo,
    onDragStart: (e: DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData(WORKSPACE_DRAG_TYPE, workspace.id)
      e.dataTransfer.effectAllowed = "move"
      onDragStartItem(workspace)
    },
    onDragEnd: () => onDragEndItem(),
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(WORKSPACE_DRAG_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "move"
      const rect = e.currentTarget.getBoundingClientRect()
      onDragOverItem(workspace, e.clientY < rect.top + rect.height / 2 ? "before" : "after")
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(WORKSPACE_DRAG_TYPE)) return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      onDropOnItem(workspace, e.clientY < rect.top + rect.height / 2 ? "before" : "after")
    },
  }

  // Alt+Up/Down moves one place, Alt+Home/End to either end (beadbox-984).
  const onReorderKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!onMoveTo || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
    const to =
      e.key === "ArrowUp"
        ? position - 1
        : e.key === "ArrowDown"
          ? position + 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? count - 1
              : null
    if (to === null) return
    e.preventDefault()
    if (to >= 0 && to < count && to !== position) onMoveTo(workspace, to)
  }

  const dropLine = dropEdge && (
    <span
      className={cn(
        "pointer-events-none absolute left-1 right-1 h-0.5 rounded-full bg-primary",
        dropEdge === "before" ? "-top-px" : "-bottom-px",
      )}
      aria-hidden="true"
      data-testid="workspace-rail-drop-line"
    />
  )

  const avatar = busy ? (
    <Loader2 className="h-4 w-4 animate-spin" />
  ) : workspace.icon ? (
    <span aria-hidden="true">{workspace.icon}</span>
  ) : isServerOnly ? (
    <Server className={cn("h-4 w-4", unavailable && "opacity-40")} />
  ) : (
    <Circle className={cn("h-4 w-4 fill-current", unavailable && "opacity-40")} />
  )

  if (collapsed) {
    return (
      <div
        data-testid="workspace-rail-item"
        data-workspace-id={workspace.id}
        className={cn("relative", dragging && "opacity-50")}
        {...dragProps}
      >
        {dropLine}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onSelect(workspace)}
              onKeyDown={onReorderKey}
              aria-current={active ? "page" : undefined}
              aria-label={`Open ${workspace.name}`}
              aria-describedby={onMoveTo ? REORDER_HINT_ID : undefined}
              data-rail-open={workspace.id}
              className={cn(
                ROW_BASE,
                FOCUS_RING,
                "justify-center px-0 py-1.5",
                active ? ROW_ACTIVE : ROW_INACTIVE,
              )}
            >
              <span
                className={cn(
                  "absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full",
                  active ? "bg-primary" : "bg-transparent",
                )}
                aria-hidden="true"
              />
              <span className={AVATAR}>{avatar}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{workspace.name}</TooltipContent>
        </Tooltip>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "group/rail-item relative flex items-center gap-2 rounded-md px-1.5 py-1.5",
        active ? ROW_ACTIVE : "hover:bg-accent/50",
        dragging && "opacity-50",
      )}
      data-testid="workspace-rail-item"
      data-workspace-id={workspace.id}
      {...dragProps}
    >
      {dropLine}
      <span
        className={cn(
          "absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full",
          active ? "bg-primary" : "bg-transparent",
        )}
        aria-hidden="true"
      />

      <button
        type="button"
        onClick={() => setEditOpen(true)}
        aria-label={`Edit ${workspace.name} tab`}
        className={cn(AVATAR, FOCUS_RING, "hover:bg-muted")}
      >
        {avatar}
      </button>

      {renaming ? (
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            commitRename()
          }}
        >
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return
              cancelledRef.current = true
              setRenaming(false)
            }}
            aria-label={`Rename ${workspace.name}`}
            className={cn(
              "w-full rounded-sm bg-background/80 px-1 py-0.5 text-sm text-foreground",
              "border border-border/60 outline-none focus:border-primary/60",
            )}
          />
        </form>
      ) : (
        <button
          type="button"
          onClick={() => onSelect(workspace)}
          onDoubleClick={startRename}
          onKeyDown={onReorderKey}
          aria-current={active ? "page" : undefined}
          aria-label={`Open ${workspace.name}`}
          aria-describedby={onMoveTo ? REORDER_HINT_ID : undefined}
          data-rail-open={workspace.id}
          className={cn("min-w-0 flex-1 text-left", FOCUS_RING, "rounded-sm")}
        >
          <span
            className={cn(
              "block truncate text-sm",
              active ? "text-foreground" : "text-muted-foreground",
              unavailable && "text-muted-foreground/60",
            )}
          >
            {workspace.name}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground/60">
            {unavailable ? "Database not found" : subtitle}
          </span>
        </button>
      )}

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Workspace options for ${workspace.name}`}
            className={cn(
              "shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity",
              "hover:bg-accent hover:text-foreground",
              "group-hover/rail-item:opacity-70 focus-visible:opacity-100",
              FOCUS_RING,
            )}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="w-44">
          <DropdownMenuItem
            onSelect={(event) => {
              // Keep Radix from closing-and-refocusing under the dialog we
              // are about to mount; closing the menu explicitly here means
              // only one layer is ever in flight.
              event.preventDefault()
              setMenuOpen(false)
              setEditOpen(true)
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit name & icon
          </DropdownMenuItem>
          {onMoveTo && (
            <>
              <DropdownMenuItem
                disabled={position === 0}
                onSelect={() => onMoveTo(workspace, position - 1)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={position === count - 1}
                onSelect={() => onMoveTo(workspace, position + 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
                Move down
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onRemove(workspace)}>
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <WorkspaceTabDialog
        workspace={workspace}
        open={editOpen}
        onOpenChange={setEditOpen}
        // One call, both fields: two overlapping setWorkspaceLabel round trips
        // are two read-modify-writes of the same registry file.
        onSubmit={(label) => onRelabel(workspace, label)}
      />
    </div>
  )
}

export interface WorkspaceRailProps {
  workspaces: WorkspaceCard[]
  activeWorkspaceId: string | null
  /** Rail width in px (ignored while collapsed). */
  width: number
  collapsed: boolean
  /** True while the dashboard route (/workspaces) is showing. */
  dashboardActive: boolean
  /** Workspace whose switch is in flight — renders a spinner on that tab. */
  switchingWorkspaceId?: string | null
  allProjectsActive?: boolean
  onAllProjects?: () => void
  onDashboard: () => void
  onSelect: (workspace: WorkspaceCard) => void
  onRemove: (workspace: WorkspaceCard) => void
  onRelabel: (
    workspace: WorkspaceCard,
    label: { name?: string; icon?: string | null },
  ) => Promise<boolean>
  /**
   * Move a workspace to `toIndex` in the sidebar order (beadbox-984). Absent:
   * the list cannot be reordered (no drag, no keys, no menu items).
   */
  onMove?: (workspace: WorkspaceCard, toIndex: number) => unknown
  onAdd: () => void
  onToggleCollapse: () => void
  onResizePointerDown: (event: PointerEvent<HTMLDivElement>) => void
}

export function WorkspaceRail({
  workspaces,
  activeWorkspaceId,
  width,
  collapsed,
  dashboardActive,
  switchingWorkspaceId,
  onDashboard,
  allProjectsActive,
  onAllProjects,
  onSelect,
  onRemove,
  onRelabel,
  onMove,
  onAdd,
  onToggleCollapse,
  onResizePointerDown,
}: WorkspaceRailProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: DropEdge } | null>(null)
  // What the live region says after a move (AC2: the move is announced).
  const [announcement, setAnnouncement] = useState("")
  // A keyboard move keeps focus on the moved row. React may move the focused
  // node when it reorders keyed siblings, and the browser blurs a node that is
  // taken out and put back, so focus is restored once the new order renders.
  const refocusIdRef = useRef<string | null>(null)
  const railRef = useRef<HTMLElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the new order renders; it reads only refs
  useEffect(() => {
    const id = refocusIdRef.current
    if (id === null) return
    refocusIdRef.current = null
    railRef.current
      ?.querySelector<HTMLButtonElement>(`[data-rail-open="${CSS.escape(id)}"]`)
      ?.focus()
  }, [workspaces])

  const moveTo = useCallback(
    (workspace: WorkspaceCard, toIndex: number, refocus: boolean) => {
      if (!onMove) return
      if (refocus) refocusIdRef.current = workspace.id
      setAnnouncement(`${workspace.name} moved to position ${toIndex + 1} of ${workspaces.length}`)
      void onMove(workspace, toIndex)
    },
    [onMove, workspaces.length],
  )

  const endDrag = useCallback(() => {
    setDraggedId(null)
    setDropTarget(null)
  }, [])

  const dropOn = useCallback(
    (target: WorkspaceCard, edge: DropEdge) => {
      const dragged = workspaces.find((w) => w.id === draggedId)
      endDrag()
      if (!dragged) return
      const from = workspaces.indexOf(dragged)
      let to = workspaces.findIndex((w) => w.id === target.id) + (edge === "after" ? 1 : 0)
      if (from < to) to -= 1
      if (to !== from) moveTo(dragged, to, false)
    },
    [draggedId, endDrag, moveTo, workspaces],
  )

  return (
    <aside
      ref={railRef}
      className="relative flex h-full shrink-0 flex-col border-r border-border/50 bg-card/40"
      style={{ width: collapsed ? WORKSPACE_RAIL_COLLAPSED_WIDTH : width }}
      aria-label="Workspaces"
      data-testid="workspace-rail"
    >
      {onAllProjects && <button
        type="button"
        onClick={onAllProjects}
        aria-current={allProjectsActive ? "page" : undefined}
        aria-label="All projects"
        title="All projects"
        className={cn(ROW_BASE, FOCUS_RING, "p-3", allProjectsActive ? ROW_ACTIVE : ROW_INACTIVE)}
      >
        <LayoutGrid className="h-5 w-5 shrink-0" />
        {!collapsed && <span>All projects</span>}
      </button>}
      {/* No bottom border here: the page header inside the content column is
          taller than this label row (its h-9 icon buttons set the height), so
          a divider would sit a few px off the header's own border. The rail
          reads as one continuous panel instead. */}
      <div
        className={cn(
          "flex shrink-0 items-center px-1.5 py-2",
          collapsed ? "justify-center" : "justify-between gap-1",
        )}
      >
        {!collapsed && (
          <span className="truncate px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Workspaces
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={collapsed ? "Expand workspace sidebar" : "Collapse workspace sidebar"}
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                FOCUS_RING,
              )}
              data-testid="workspace-rail-toggle"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? "Expand" : "Collapse"}</TooltipContent>
        </Tooltip>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDashboard}
              aria-current={dashboardActive ? "page" : undefined}
              aria-label="Dashboard"
              className={cn(
                ROW_BASE,
                FOCUS_RING,
                "py-1.5",
                collapsed ? "justify-center px-0" : "",
                dashboardActive ? ROW_ACTIVE : ROW_INACTIVE,
              )}
              data-testid="workspace-rail-dashboard"
            >
              <span
                className={cn(
                  "absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full",
                  dashboardActive ? "bg-primary" : "bg-transparent",
                )}
                aria-hidden="true"
              />
              <span className={cn(AVATAR, "bg-transparent")}>
                <LayoutGrid className="h-4 w-4" />
              </span>
              {!collapsed && <span className="truncate">Dashboard</span>}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">All workspaces</TooltipContent>
        </Tooltip>

        <div className="my-1 border-t border-border/40" aria-hidden="true" />

        {workspaces.length === 0 && !collapsed && (
          <p className="px-2 py-1 text-xs text-muted-foreground/70">No workspaces yet</p>
        )}
        {workspaces.map((workspace, index) => (
          <WorkspaceRailItem
            key={workspace.id}
            workspace={workspace}
            position={index}
            count={workspaces.length}
            active={workspace.id === activeWorkspaceId && !dashboardActive}
            collapsed={collapsed}
            busy={switchingWorkspaceId === workspace.id}
            dragging={draggedId === workspace.id}
            dropEdge={
              draggedId !== null && draggedId !== workspace.id && dropTarget?.id === workspace.id
                ? dropTarget.edge
                : null
            }
            onDragStartItem={(w) => setDraggedId(w.id)}
            onDragEndItem={endDrag}
            onDragOverItem={(w, edge) =>
              setDropTarget((prev) => (prev?.id === w.id && prev.edge === edge ? prev : { id: w.id, edge }))
            }
            onDropOnItem={dropOn}
            onMoveTo={onMove ? (w, to) => moveTo(w, to, true) : undefined}
            onSelect={onSelect}
            onRemove={onRemove}
            onRelabel={onRelabel}
          />
        ))}
      </nav>

      {onMove && (
        <>
          <span id={REORDER_HINT_ID} className="sr-only">
            Alt+Up or Alt+Down to reorder
          </span>
          <div aria-live="polite" className="sr-only" data-testid="workspace-rail-announcer">
            {announcement}
          </div>
        </>
      )}

      <div className="shrink-0 border-t border-border/50 p-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onAdd}
              aria-label="Add workspace"
              className={cn(
                ROW_BASE,
                FOCUS_RING,
                "py-1.5",
                collapsed ? "justify-center px-0" : "",
                ROW_INACTIVE,
              )}
              data-testid="workspace-rail-add"
            >
              <span className={cn(AVATAR, "h-7 w-7 bg-transparent")}>
                <Plus className="h-4 w-4" />
              </span>
              {!collapsed && <span className="truncate">Add workspace</span>}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Add a local or remote workspace</TooltipContent>
        </Tooltip>
      </div>

      {!collapsed && (
        <div
          onPointerDown={onResizePointerDown}
          className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
          data-testid="workspace-rail-resize-handle"
          aria-hidden="true"
        />
      )}
    </aside>
  )
}
