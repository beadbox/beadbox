// A filter-bar dropdown with a master "All ..." row and one checkbox row per
// option. Extracted from the Status filter (beadbox-brg) so the Status and
// Priority filters share one control (beadbox-813). It only renders and
// reports clicks: what an empty selection means, and what the master row
// does, belong to the caller.
//
// Keyboard: the trigger opens it with Enter or Space; focus moves through the
// rows with ArrowUp / ArrowDown (wrapping) and Home / End; Space or Enter
// toggles the focused row; Escape closes it.

import { SlidersHorizontal } from "lucide-react"
import type { KeyboardEvent, ReactNode } from "react"

import { Button } from "./ui/button"
import { Checkbox } from "./ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

export interface MultiSelectOption<T extends string> {
  value: T
  label: string
}

interface MultiSelectFilterProps<T extends string> {
  triggerLabel: string
  triggerClassName: string
  /** Accessible name for the trigger, e.g. "Priority filter". */
  ariaLabel?: string
  allLabel: string
  allState: boolean | "indeterminate"
  onToggleAll: () => void
  options: readonly MultiSelectOption<T>[]
  selected: readonly T[]
  onToggle: (value: T) => void
  /** Extra rows under the options (the Status filter's Grouped toggle). */
  footer?: ReactNode
}

const ROW_CLASS =
  "w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none rounded-sm text-left"

/** Rows of the open dropdown, in order, for arrow-key focus movement. */
const ROW_SELECTOR = "button[data-multi-select-row]"

function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"]
  if (!keys.includes(event.key)) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR))
  if (rows.length === 0) return
  event.preventDefault()
  const current = rows.indexOf(document.activeElement as HTMLButtonElement)
  let next: number
  if (event.key === "Home") next = 0
  else if (event.key === "End") next = rows.length - 1
  else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % rows.length
  else next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length
  rows[next].focus()
}

export function MultiSelectRow({
  label,
  checked,
  onClick,
  emphasis = false,
}: {
  label: string
  checked: boolean | "indeterminate"
  onClick: () => void
  emphasis?: boolean
}) {
  return (
    <button type="button" data-multi-select-row="" onClick={onClick} className={ROW_CLASS}>
      <Checkbox checked={checked} className="pointer-events-none" aria-label={label} />
      <span className={emphasis ? "font-medium" : undefined}>{label}</span>
    </button>
  )
}

export function MultiSelectFilter<T extends string>({
  triggerLabel,
  triggerClassName,
  ariaLabel,
  allLabel,
  allState,
  onToggleAll,
  options,
  selected,
  onToggle,
  footer,
}: MultiSelectFilterProps<T>) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className={triggerClassName} aria-label={ariaLabel}>
          <span className="truncate">{triggerLabel}</span>
          <SlidersHorizontal className="h-3.5 w-3.5 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <div className="py-1" onKeyDown={moveFocus}>
          <MultiSelectRow label={allLabel} checked={allState} onClick={onToggleAll} emphasis />
          <div className="my-1 border-t border-border" />
          {options.map((option) => (
            <MultiSelectRow
              key={option.value}
              label={option.label}
              checked={selected.includes(option.value)}
              onClick={() => onToggle(option.value)}
            />
          ))}
          {footer && (
            <>
              <div className="my-1 border-t border-border" />
              {footer}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
