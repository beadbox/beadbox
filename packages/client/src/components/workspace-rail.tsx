// Left-hand workspace rail — vertical project tabs.
//
// Presentational only: every piece of state (width, collapsed, active id,
// in-flight switch, which tab is being renamed) arrives as props or stays
// local to a tab, so the rail can be rendered bare in unit tests
// (packages/client/src/__tests__/workspace-rail.test.tsx). The container
// that owns rpc + persistence is workspace-rail-panel.tsx.

import {
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
import { type PointerEvent, useCallback, useRef, useState } from "react"
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
// Two-line tab: 36px avatar inside py-1.5 → ~48px, twice a single-line row.
const AVATAR =
  "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/60 text-lg"

interface WorkspaceRailItemProps {
  workspace: WorkspaceCard
  active: boolean
  collapsed: boolean
  busy: boolean
  onSelect: (workspace: WorkspaceCard) => void
  onRemove: (workspace: WorkspaceCard) => void
  onRelabel: (
    workspace: WorkspaceCard,
    label: { name?: string; icon?: string | null },
  ) => Promise<boolean>
}

function WorkspaceRailItem({
  workspace,
  active,
  collapsed,
  busy,
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
      <div data-testid="workspace-rail-item">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onSelect(workspace)}
              aria-current={active ? "page" : undefined}
              aria-label={`Open ${workspace.name}`}
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
      )}
      data-testid="workspace-rail-item"
    >
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
          aria-current={active ? "page" : undefined}
          aria-label={`Open ${workspace.name}`}
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
  onDashboard: () => void
  onSelect: (workspace: WorkspaceCard) => void
  onRemove: (workspace: WorkspaceCard) => void
  onRelabel: (
    workspace: WorkspaceCard,
    label: { name?: string; icon?: string | null },
  ) => Promise<boolean>
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
  onSelect,
  onRemove,
  onRelabel,
  onAdd,
  onToggleCollapse,
  onResizePointerDown,
}: WorkspaceRailProps) {
  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-border/50 bg-card/40"
      style={{ width: collapsed ? WORKSPACE_RAIL_COLLAPSED_WIDTH : width }}
      aria-label="Workspaces"
      data-testid="workspace-rail"
    >
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
        {workspaces.map((workspace) => (
          <WorkspaceRailItem
            key={workspace.id}
            workspace={workspace}
            active={workspace.id === activeWorkspaceId && !dashboardActive}
            collapsed={collapsed}
            busy={switchingWorkspaceId === workspace.id}
            onSelect={onSelect}
            onRemove={onRemove}
            onRelabel={onRelabel}
          />
        ))}
      </nav>

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
