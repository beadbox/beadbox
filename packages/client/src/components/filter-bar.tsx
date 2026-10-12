"use client"

import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import {
  ArrowUpDown,
  Calendar,
  FileText,
  MessageSquare,
  Search,
  SlidersHorizontal,
  Waves,
} from "lucide-react"
import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { MultiSelectFilter, MultiSelectRow } from "@/components/multi-select-filter"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useViewport } from "@/hooks/use-viewport"
import { getAnalyticsEnabled } from "@/lib/local-storage"
import { safeCapture } from "@/lib/posthog-safe"
import { ALL_PRIORITIES, type BeadPriority, type BeadStatus, type Filters, priorityFilterNarrows } from "@/lib/types"
import { cn } from "@/lib/utils"

export type { Filters }

type SortField = "title" | "priority" | "status" | "updated"
type SortDirection = "asc" | "desc"
export interface SortOption {
  field: SortField
  direction: SortDirection
}

interface FilterBarProps {
  filters: Filters
  onFiltersChange: (filters: Filters) => void
  assignees: string[]
  rigNames?: string[]
  availableStatuses?: string[]
  availableTypes?: string[]
  selectedType?: string
  onTypeChange?: (type: string) => void
  includeSystem?: boolean
  onIncludeSystemChange?: (enabled: boolean) => void
  // Omit both to hide the sort control (the Chart view keeps tree order).
  sort?: SortOption
  onSortChange?: (sort: SortOption) => void
}

// Encode sort option as string for select value
function encodeSortValue(sort: SortOption): string {
  return `${sort.field}:${sort.direction}`
}

// Decode select value back to sort option
function decodeSortValue(value: string): SortOption {
  const [field, direction] = value.split(":") as [SortField, SortDirection]
  return { field, direction }
}

const sortOptions = [
  { value: "updated:desc", label: "Updated (Newest)" },
  { value: "updated:asc", label: "Updated (Oldest)" },
  { value: "title:asc", label: "Title (A-Z)" },
  { value: "title:desc", label: "Title (Z-A)" },
  { value: "priority:asc", label: "Priority (High-Low)" },
  { value: "priority:desc", label: "Priority (Low-High)" },
  { value: "status:asc", label: "Status (Open first)" },
  { value: "status:desc", label: "Status (Closed first)" },
]

// beadbox-813: the Priority filter's rows, P0 first.
const PRIORITY_LABELS: Record<BeadPriority, string> = {
  critical: "P0 - Critical",
  high: "P1 - High",
  medium: "P2 - Medium",
  low: "P3 - Low",
  backlog: "P4 - Backlog",
}
const PRIORITY_OPTIONS = ALL_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))

// Human-readable labels for status values
const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  closed: "Closed",
  ready_for_qa: "Ready for QA",
  ready_to_ship: "Ready to Ship",
  blocked: "Blocked",
  deferred: "Deferred",
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export function FilterBar({
  filters,
  onFiltersChange,
  assignees,
  rigNames,
  availableStatuses,
  availableTypes = [],
  selectedType = "all",
  onTypeChange,
  includeSystem = false,
  onIncludeSystemChange,
  sort,
  onSortChange,
}: FilterBarProps) {
  const { isDesktop } = useViewport()
  const [filtersOpen, setFiltersOpen] = useState(false)

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    onFiltersChange({ ...filters, [key]: value })
  }

  const activeFilterCount = useMemo(() => {
    let count = 0
    // beadbox-brg: any subset of statuses (incl. single selection) counts as
    // an active filter; empty = no filter. `grouped` is a display mode (not
    // a filter narrowing the bead set), so it doesn't bump the badge.
    if (filters.status.length > 0) count++
    if (priorityFilterNarrows(filters.priority)) count++
    if (filters.assignee !== "all") count++
    if (filters.showMessages) count++
    if (filters.showWaves) count++
    if (filters.hasSpec) count++
    if (filters.hasDeadline) count++
    if (filters.rig !== "all") count++
    return count
  }, [filters])

  // beadbox-brg: status-multi-select wiring. allStatuses is the ordered set
  // surfaced in the dropdown (workspace's availableStatuses if loaded,
  // otherwise the core-three fallback for first-paint). The filter is a
  // strict whitelist — a row is checked iff its status is in filters.status.
  const allStatuses: string[] =
    availableStatuses && availableStatuses.length > 0
      ? availableStatuses
      : ["open", "in_progress", "closed"]
  const allSelected = allStatuses.every((s) => filters.status.includes(s as BeadStatus))

  function toggleStatus(status: BeadStatus): void {
    const current = filters.status
    const next = current.includes(status)
      ? current.filter((s) => s !== status)
      : ([...current, status] as BeadStatus[])
    updateFilter("status", next)
  }

  function toggleAllStatuses(): void {
    // Master toggle: if every available status is checked → clear (deselect
    // all); otherwise → check every available status. Standard Linear/Gmail
    // multi-select header semantic.
    updateFilter("status", allSelected ? [] : (allStatuses as BeadStatus[]))
  }

  function statusTriggerLabel(): string {
    if (allSelected) return "All Status"
    if (filters.status.length === 0) return "No Status"
    if (filters.status.length === 1) return statusLabel(filters.status[0])
    return `${filters.status.length} statuses`
  }

  // beadbox-813: priority multi-select, on the same control as Status. Unlike
  // status, an empty selection means "All Priority" (never a blank list), and
  // so does all five; the master row resets to All.
  const priorityNarrows = priorityFilterNarrows(filters.priority)

  function togglePriority(priority: BeadPriority): void {
    const current = filters.priority
    const next = current.includes(priority)
      ? current.filter((p) => p !== priority)
      : [...current, priority]
    updateFilter("priority", next)
  }

  function priorityTriggerLabel(): string {
    if (!priorityNarrows) return "All Priority"
    if (filters.priority.length === 1) return PRIORITY_LABELS[filters.priority[0]]
    return `${filters.priority.length} priorities`
  }

  const triggerClassName = cn(
    "justify-between font-normal",
    isDesktop
      ? "w-[160px] h-9 px-3 bg-transparent border-0 rounded-none"
      : "w-full min-h-[44px] bg-transparent border border-border/50",
  )

  const filterControls = (
    <>
      {/* Status Filter — beadbox-brg multi-select + Grouped toggle */}
      <MultiSelectFilter
        triggerLabel={statusTriggerLabel()}
        triggerClassName={triggerClassName}
        ariaLabel="Status filter"
        allLabel="All Status"
        allState={allSelected ? true : filters.status.length === 0 ? false : "indeterminate"}
        onToggleAll={toggleAllStatuses}
        options={allStatuses.map((s) => ({ value: s as BeadStatus, label: statusLabel(s) }))}
        selected={filters.status}
        onToggle={toggleStatus}
        footer={
          <MultiSelectRow
            label="Grouped"
            checked={filters.grouped}
            onClick={() => updateFilter("grouped", !filters.grouped)}
          />
        }
      />

      {/* Issue Type Filter */}
      {onTypeChange && (
        <Select value={selectedType} onValueChange={onTypeChange}>
          <SelectTrigger
            className={
              isDesktop
                ? "w-[140px] h-9 bg-transparent border-0 rounded-none"
                : "w-full min-h-[44px] bg-transparent border-border/50"
            }
            aria-label="Issue type"
          >
            <SelectValue placeholder="Issue type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {[...new Set([selectedType, ...availableTypes])]
              .filter((type) => type !== "all")
              .map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      )}

      {/* System Issues Toggle */}
      {onIncludeSystemChange && (
        <label className="flex items-center gap-2 px-3 text-sm cursor-pointer">
          <Checkbox
            checked={includeSystem}
            onCheckedChange={(checked) => onIncludeSystemChange(checked === true)}
            aria-label="Show system issues"
          />
          <span>System issues</span>
        </label>
      )}

      {/* Priority Filter — beadbox-813 multi-select (same control as Status) */}
      <MultiSelectFilter
        triggerLabel={priorityTriggerLabel()}
        triggerClassName={triggerClassName}
        ariaLabel="Priority filter"
        allLabel="All Priority"
        allState={priorityNarrows ? "indeterminate" : true}
        onToggleAll={() => updateFilter("priority", [])}
        options={PRIORITY_OPTIONS}
        selected={filters.priority}
        onToggle={togglePriority}
      />

      {/* Assignee Filter */}
      <Select value={filters.assignee} onValueChange={(value) => updateFilter("assignee", value)}>
        <SelectTrigger
          className={
            isDesktop
              ? "w-[165px] h-9 bg-transparent border-0 rounded-none"
              : "w-full min-h-[44px] bg-transparent border-border/50"
          }
        >
          <SelectValue placeholder="Assignee" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Assignees</SelectItem>
          {assignees.map((assignee) => (
            <SelectItem key={assignee} value={assignee}>
              {assignee}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Rig Filter (only for multi-rig workspaces) */}
      {rigNames && rigNames.length > 0 && (
        <Select value={filters.rig} onValueChange={(value) => updateFilter("rig", value)}>
          <SelectTrigger
            className={
              isDesktop
                ? "w-[140px] h-9 bg-transparent border-0 rounded-none"
                : "w-full min-h-[44px] bg-transparent border-border/50"
            }
          >
            <SelectValue placeholder="Rig" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Rigs</SelectItem>
            {rigNames.map((rig) => (
              <SelectItem key={rig} value={rig}>
                {rig}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Sort */}
      {sort && onSortChange && (
        <Select
          value={encodeSortValue(sort)}
          onValueChange={(value) => {
            const newSort = decodeSortValue(value)
            if (getAnalyticsEnabled()) {
              safeCapture("app_sort_changed", {
                sort_field: newSort.field,
                sort_direction: newSort.direction,
                previous_field: sort.field,
                previous_direction: sort.direction,
              })
            }
            onSortChange(newSort)
          }}
        >
          <SelectTrigger
            className={
              isDesktop
                ? "w-[235px] h-9 bg-transparent border-0 rounded-none"
                : "w-full min-h-[44px] bg-transparent border-border/50"
            }
          >
            <ArrowUpDown className="h-4 w-4 mr-2 text-muted-foreground" />
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Filter Toggles */}
      <TooltipProvider delayDuration={200} skipDelayDuration={0}>
        <ToggleGroup
          type="multiple"
          variant="outline"
          size={isDesktop ? "sm" : "lg"}
          value={[
            ...(filters.showMessages ? ["showMessages"] : []),
            ...(filters.showWaves ? ["showWaves"] : []),
            ...(filters.hasSpec ? ["hasSpec"] : []),
            ...(filters.hasDeadline ? ["hasDeadline"] : []),
          ]}
          onValueChange={(value: string[]) => {
            onFiltersChange({
              ...filters,
              showMessages: value.includes("showMessages"),
              showWaves: value.includes("showWaves"),
              hasSpec: value.includes("hasSpec"),
              hasDeadline: value.includes("hasDeadline"),
            })
          }}
        >
          <TooltipPrimitive.Root>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value="showMessages"
                aria-label="Show messages"
                className={cn(
                  !isDesktop ? "min-h-[44px] min-w-[44px]" : "",
                  filters.showMessages && "bg-primary/20 text-primary",
                )}
              >
                <MessageSquare className="h-4 w-4" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>Show messages</TooltipContent>
          </TooltipPrimitive.Root>
          <TooltipPrimitive.Root>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value="showWaves"
                aria-label="Show waves"
                className={cn(
                  !isDesktop ? "min-h-[44px] min-w-[44px]" : "",
                  filters.showWaves && "bg-primary/20 text-primary",
                )}
              >
                <Waves className="h-4 w-4" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>Show waves</TooltipContent>
          </TooltipPrimitive.Root>
          <TooltipPrimitive.Root>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value="hasSpec"
                aria-label="Has spec"
                className={cn(
                  !isDesktop ? "min-h-[44px] min-w-[44px]" : "",
                  filters.hasSpec && "bg-primary/20 text-primary",
                )}
              >
                <FileText className="h-4 w-4" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>Has spec</TooltipContent>
          </TooltipPrimitive.Root>
          <TooltipPrimitive.Root>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value="hasDeadline"
                aria-label="Has deadline"
                className={cn(
                  !isDesktop ? "min-h-[44px] min-w-[44px]" : "",
                  filters.hasDeadline && "bg-primary/20 text-primary",
                )}
              >
                <Calendar className="h-4 w-4" />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>Has deadline</TooltipContent>
          </TooltipPrimitive.Root>
        </ToggleGroup>
      </TooltipProvider>
    </>
  )

  if (isDesktop) {
    return (
      <div data-testid="filter-bar" className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            data-search-input
            placeholder="Search by title or ID..."
            value={filters.search}
            onChange={(e) => updateFilter("search", e.target.value)}
            className="pl-9 h-9 bg-transparent border-0 rounded-none"
          />
        </div>
        {filterControls}
      </div>
    )
  }

  return (
    <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen} data-testid="filter-bar">
      <div className="flex items-center gap-2">
        {/* Search - full width on mobile */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            data-search-input
            placeholder="Search by title or ID..."
            value={filters.search}
            onChange={(e) => updateFilter("search", e.target.value)}
            className="pl-9 min-h-[44px] bg-transparent border-0 rounded-none"
          />
        </div>

        {/* Filter toggle button */}
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="relative min-h-[44px] min-w-[44px] text-muted-foreground hover:text-foreground shrink-0"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {activeFilterCount > 0 && !filtersOpen && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent>
        <div className="flex flex-col gap-2 pt-2">{filterControls}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
