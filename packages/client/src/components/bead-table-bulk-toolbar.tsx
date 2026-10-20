// bb-y729: floating toolbar that appears when ≥1 bead-table row is selected.
// Bulk actions: Status (beadbox-id1, GH #59) and Archive. Future bulk ops
// (reparent, priority change) extend this component without changing the
// selection state contract on home-page.

import { Archive, CircleDot, Loader2, X } from "lucide-react"
import { getStatusDisplayConfig } from "@/components/bead-detail-helpers"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

interface BeadTableBulkToolbarProps {
  selectedCount: number
  onBulkArchive: () => void | Promise<void>
  /** beadbox-id1: the statuses the detail panel's status control offers. */
  availableStatuses: string[]
  onBulkStatus: (status: string) => void | Promise<void>
  onClear: () => void
  /** Any bulk action in flight: every control is disabled. */
  isPending?: boolean
  /** Which action carries the spinner while isPending. */
  pendingAction?: "archive" | "status"
  className?: string
}

export function BeadTableBulkToolbar({
  selectedCount,
  onBulkArchive,
  availableStatuses,
  onBulkStatus,
  onClear,
  isPending = false,
  pendingAction = "archive",
  className,
}: BeadTableBulkToolbarProps) {
  if (selectedCount === 0) return null

  return (
    <div
      className={cn(
        "bead-table-bulk-toolbar flex items-center gap-3 px-3 py-2 border-b border-border/50 bg-primary/10",
        className,
      )}
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span className="text-sm font-medium text-foreground/80">{selectedCount} selected</span>
      <div className="flex-1" />
      {/* beadbox-id1: Radix opens the menu on Enter, Space or ArrowDown, moves
          with the arrows, and closes on Escape without picking. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            aria-label="Set status of selected"
          >
            {isPending && pendingAction === "status" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CircleDot className="h-4 w-4" />
            )}
            Status
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {availableStatuses.map((s) => {
            const config = getStatusDisplayConfig(s)
            return (
              <DropdownMenuItem
                key={s}
                onSelect={() => {
                  void onBulkStatus(s)
                }}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full", config.dotClass)} />
                {config.label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void onBulkArchive()
        }}
        disabled={isPending}
        aria-label="Archive selected"
      >
        {isPending && pendingAction === "archive" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Archive className="h-4 w-4" />
        )}
        Archive
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClear}
        disabled={isPending}
        aria-label="Clear selection"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
